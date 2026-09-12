# Installation Security Remediation — Baseline

Snapshot of the **current** behavior of the installation/evidence subsystem
BEFORE the EVID-SEC / DEPLOY-PORT / EVID-STATE remediation. Captured from HEAD
`4d60a84`. Nothing here is changed yet; this document is the reference against
which the fixes are made.

## Files in scope

`deploy/scripts/install.sh`, `deploy/scripts/update.sh`,
`deploy/scripts/lib/evidence.sh`, `deploy/scripts/support-bundle.sh`,
`deploy/scripts/deployment-note.sh`, `deploy/scripts/validate-after-reboot.sh`,
`deploy/nginx/netsphere.conf`, `deploy/README.md`,
`docs/INSTALLATION_EVIDENCE.md`.

---

## 1. Where environment variables are collected — **LEAK (EVID-SEC-001)**

`evidence.sh :: collect_system_info()` (line ~395) ends with:

```bash
echo "----- Environment (sanitized, §8) -----"
env | sort
```

The **entire process environment** is dumped and only then piped through
`redact_stream`. Redaction is pattern-based, so any secret-bearing variable
whose **name** does not match the sensitive-word list (e.g. a value inside
`JAVA_TOOL_OPTIONS`, an unknown token var, `AWS_ACCESS_KEY_ID`) can survive.
**This is prohibited by the spec** — must become an allowlist.

## 2. Current redaction behavior

`evidence.sh :: redact_stream()` (line ~86):
- `_EV_SENSITIVE_WORDS = PASSWORD|PASSWD|PASS|SECRET|TOKEN|PRIVATE_KEY|PRIVKEY|
  AUTHORIZATION|AUTH_TOKEN|COOKIE|API_KEY|APIKEY|JWT|CREDENTIAL|ENCRYPTION_KEY|
  PSK|BEARER`.
- Rules (in order): `Authorization:` header → `[REDACTED]`; `Cookie:` /
  `Set-Cookie:` → `[REDACTED]`; generic `KEY=value` / `KEY: value` where KEY
  contains a sensitive word → value `[REDACTED]`; PEM `BEGIN…PRIVATE KEY` blocks
  → dropped.
- **Gaps vs spec:**
  - No `PWD`, `CLIENT_SECRET`, `ACCESS_KEY`, `PAT` coverage (§4).
  - **Credential-bearing URLs** (`postgres://user:pass@…`, `redis://:pass@…`,
    etc.) are NOT redacted (§5) — the password survives.
  - `AUTHORIZATION=Bearer …` (the **`=`** form, not the `:` header form) is only
    handled by the generic rule, which stops at the first space and can leave
    the token: `AUTHORIZATION=[REDACTED] eyJ…` (§6 forbids this).
  - `DATABASE_URL` / `REDIS_URL` names don't match any sensitive word (§7).

## 3. Where bootstrap credentials are printed — **LEAK (EVID-SEC-002)**

Two execution paths print the bootstrap admin block, **including the password**:

- `install.sh` line ~216 (secret generation branch):
  ```bash
  grep "BOOTSTRAP_ADMIN" .env.production
  ```
- `install.sh` line ~465 (final summary):
  ```bash
  Bootstrap admin credentials (in .env.production):
  $(grep BOOTSTRAP_ADMIN .env.production | sed 's/^/    /')
  ```

Both emit `BOOTSTRAP_ADMIN_PASSWORD=<value>` to **stdout** (terminal). The
evidence-aware `say/ok` helpers are not used here, so it is not written to
evidence — but it IS shown on the operator's screen / any captured stdout, which
the spec prohibits (§10/§12).

## 4. Current Nginx HTTPS port — **hardcoded (DEPLOY-PORT-001)**

`deploy/nginx/netsphere.conf`:
- HTTPS server: `listen 6655 ssl http2;` / `listen [::]:6655 ssl http2;`.
- The port is **hardcoded to 6655**; the installer only `sed`-substitutes the
  domain, never the port. There is no way for the operator to choose it.

## 5. Current HTTP redirect target

`netsphere.conf` port-80 server:
```nginx
location / { return 301 https://$host:6655$request_uri; }
```
Hardcoded `:6655`.

## 6. Current public URL generation — **inconsistent**

`install.sh` final summary prints:
```
Public URL:  https://${NETSPHERE_DOMAIN}
VITE_API_BASE_URL=https://${NETSPHERE_DOMAIN}
```
i.e. **no port** — while nginx actually listens on **6655**. So the printed URL
(`https://domain`) does not match the real endpoint (`https://domain:6655`):
a concrete 443/6655 mismatch.

## 7. Firewall guidance — **inconsistent**

- `install.sh` summary: “Configure firewall: allow only 22 (SSH), 80, **443**.”
- `deploy/README.md` line 209: `sudo ufw allow 6655/tcp   # HTTPS`.
- `deploy/README.md` line 290 checklist: “allow only 22, 80, **443**”.

443 vs 6655 contradictions. The installer only **prints guidance**; it does NOT
run ufw/iptables itself (so no auto-firewall behavior to preserve for HTTPS).
`update.sh` DOES manage ufw, but only for `VPN_PORTS` (1194), unrelated to HTTPS.

## 8. `VITE_API_BASE_URL`

- `install.sh` prints `VITE_API_BASE_URL=https://${NETSPHERE_DOMAIN}` (no port).
- `update.sh` default `API_BASE_URL=https://161.97.78.116.nip.io:6655` (a
  hardcoded host+port). `update.sh` builds the frontend with this and does not
  read any persisted port.

## 9. Certbot / TLS flow

`install.sh` Step 5/6 (unchanged DEPLOY-002 logic):
1. Prompt for domain (or `skip`).
2. Copy `netsphere.conf` → `/etc/nginx/sites-available/netsphere`, sed domain.
3. If cert exists → `enable_final` (symlink, `nginx -t`, reload).
4. Else write HTTP-only bootstrap vhost (ACME webroot on **:80**), `nginx -t`,
   reload; prompt “Continue with certbot issuance? [Y/n]”.
   - **Operator answers N** → warn + leave bootstrap; **falls through to the
     final SUCCESS finalize** (see §10 below — this is EVID-STATE-001).
   - Operator answers Y → `certbot certonly --webroot`; on failure `err` →
     FAILED (non-zero); on success `enable_final`.

ACME always uses **port 80**, independent of the HTTPS port. Good — keep.

## 10. SUCCESS / PARTIAL / FAILED decision logic — **wrong (EVID-STATE-001)**

`install.sh` line ~439:
```bash
_finalize_once SUCCESS
```
is reached **unconditionally** after Step 6, and prints
`INSTALLATION COMPLETED / Status: SUCCESS`. There is **no PARTIAL state**.
Consequences:
- Operator **skips TLS** (answers N) → still finalizes **SUCCESS** and exits 0.
  The production HTTPS endpoint is not active, yet automation sees success. This
  is the EVID-STATE-001 bug.
- Certbot **failure** → `err` → FAILED, exit 1 (correct; keep).
- `evidence.sh :: evidence_finalize` accepts `SUCCESS|FAILED|PARTIAL` but the
  report/manifest have **no `incomplete_gates`** field, and PARTIAL is never
  emitted. Exit-code policy has no PARTIAL code.

## 11. Support bundle (current)

`support-bundle.sh`:
- Denylist `.env*`, `*.key`, `*.pem`, `*.p12/pfx`, `*.sql/dump`, `id_rsa*`,
  `id_ed25519*`, `*.kdbx`, `.pgpass`, `.htpasswd`, plus `.manifest/`.
- Re-redacts every text file; blocking `scan_file` scanner rejects on surviving
  sensitive `KEY=value`, PEM, or bearer.
- **Gaps vs spec:** scanner does not explicitly test credential-bearing URIs
  (`postgres://user:pass@`) as a category (relies on the word `PASSWORD`, which
  those URIs don't contain); `RUN_ID` is used unvalidated to build
  `${ROOT}/${RUN_ID}` (path-traversal / symlink hardening missing, §56/§57).

## 12. Existing evidence tests

- `deploy/scripts/tests/evidence-test.sh` — 31 unit tests (run-dir, redaction,
  errors/warnings, manifest, report, bundle, scanner).
- `deploy/scripts/tests/install-sim-test.sh` — 33 end-to-end sim tests (success
  + 5 failure scenarios).
- **Missing:** credential-URL redaction, `=`-form Authorization, unknown-env
  non-dump, bundle-rejects-injected-secret bootstrap non-display, HTTPS-port
  selection/propagation/validation/conflict/update-preservation, and
  Skip-TLS=PARTIAL (§35–§55).

---

## Remediation targets (summary)

| ID | Fix |
| -- | --- |
| EVID-SEC-001 | Replace `env|sort` with `collect_safe_environment` allowlist |
| EVID-SEC-002 | Never print bootstrap password (remove both `grep BOOTSTRAP_ADMIN` prints) |
| DEPLOY-PORT-001 | Operator-selectable HTTPS port (default 443), templated nginx, centralized URL builder, propagate everywhere, persist in `/etc/awamer/deployment.conf`, preserve on update |
| EVID-STATE-001 | Skip-TLS → PARTIAL (+ `incomplete_gates`, exit code 2); certbot failure stays FAILED |
| EVID-TEST-001 | Add secret/port/state tests; keep existing tests passing |
