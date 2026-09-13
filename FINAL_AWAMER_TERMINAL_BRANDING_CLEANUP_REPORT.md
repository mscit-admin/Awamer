# FINAL Awamer Terminal — Branding Cleanup Report

**Scope:** Rebrand the product to **"Awamer Terminal"** (short name **"Awamer"**)
across all user-facing surfaces and active documentation, and remove visible
`NetSphere` references — **without renaming any architecture, technical identifier,
or anything that could break existing installations.** Text/branding only.

Branch: `claude/nifty-johnson-u2dwye`.

> **Goal restated:** *Rename the branding, not the architecture.* No global blind
> search-and-replace was performed — every occurrence was individually classified.

---

## Verdict

```
VISIBLE_NETSPHERE_REFERENCES (browser, desktop, login, dashboard, installer,
                              about, reports, docs, user-facing errors)   = 0
Functionality changed                                                     = NONE
Security / RBAC / auth / crypto / networking logic touched                = NONE
Regression                                                                = 0 (all suites green)
```

The app functions exactly as before. The one remaining **capitalized** `NetSphere`
in an active file is a historical CHANGELOG record of the *old literal default value*
(quoted, describing a past bug) — retained on purpose (see below).

---

## Method (inventory-first, then classify, then edit)

1. **Inventory before any edit** — `grep -RniE 'netsphere|net[[:space:]]+sphere'`
   over the repo (excluding `node_modules/.git/dist/build/target`): **349** matches
   across 84 files (saved to `branding-inventory-before.txt`).
2. **Classified every match** into:
   - **(A) User-facing branding** → replace (titles, window/app name, installer/CLI
     banners, systemd description, API-docs title, user-facing error/help text).
   - **(B) Active documentation** → replace product name (README, deploy guide,
     architecture doc, release-notes/changelog headers).
   - **(C) Comments/descriptions** → safe to update (file headers, code comments).
   - **(T) Technical identifiers** → **retain** (storage keys, bundle/keyring id,
     crypto salt, JWT issuer, DB user/name, Docker resource names, env vars, paths,
     package/crate names, nginx template token, backup prefixes, log paths).
3. **Edited only A/B/C**; retained all T. Re-scanned and regression-tested.

---

## Category table — Before / Replaced / Retained

| Category | Surface / examples | Before | Replaced (rebranded) | Retained (why) |
| --- | --- | ---: | ---: | --- |
| **UI (browser/web)** | `desktop/index.html` `<title>`, `branding.tsx` default app name (`ENV_NAME`), `VITE_APP_NAME` in `.env.example`, in-app error/help strings (`VpnPage`, `TerminalPane`, `vpnApi`, `tauri.ts`) | 8 | 8 | `netsphere.*` **localStorage keys** (9 distinct) retained — renaming would drop returning users' saved session/theme/token state |
| **Desktop (Tauri/Rust)** | `tauri.conf.json` `productName` + window `title` + `longDescription`; `Cargo.toml` `description`+`authors`; `lib.rs` header + startup log banner; `known_hosts.rs` comment | 12 | 9 | Bundle id `io.netsphere.terminal`, OS keyring `SERVICE`, crate names `netsphere-terminal`/`netsphere_terminal_lib`, `~/.netsphere/known_hosts` path — load-bearing OS/identity/path identifiers |
| **Installer / CLI** | `install.sh` header + domain-prompt example + "installation complete" banner; root `install.sh` header + "ready" banner; `systemd` unit `Description`; `Makefile` help; deploy-script comment headers | 46 (install.sh) + others | 12 | Container/network/volume/image names, `NETSPHERE_DOMAIN` env var, nginx site paths, DB user (`psql -U netsphere`), `/opt/netsphere` install dir, backup file prefixes, `netsphere.service` unit filename |
| **Documentation** | `README.md`, `deploy/README.md`, `docs/architecture.md`, `CLAUDE.md`, `RELEASE_NOTES.md` (title + prose), `CHANGELOG.md` header + new entry | ~90 | ~14 | Operational commands/paths inside docs (tarball names, `/opt/netsphere`, container names, log paths, DB users) — they document real resources |
| **Comments / descriptions** | Backend `vnc/gateway.ts`, `api.ts`, file headers in configs/scripts/`.gitignore`/hook | — | (incl. above) | Comments that reference a **real retained identifier/path** are kept accurate |
| **Config metadata** | `backend/package.json` + `desktop/package.json` `description`; `Cargo.toml` `description` | 3 | 3 | Package **names** (`netsphere-auth-service`, `netsphere-terminal-desktop`) + lockfile names retained |
| **Technical identifiers** | JWT issuer, crypto salt, DB/Docker/env/path/keyring/bundle ids | — | 0 | **All retained** — see table below |
| **Historical reports** | `FINAL_*.md`, `PHASE_*.md`, `*_BASELINE.md` (dated engineering/security records) | 48 | 0 | Point-in-time records; rewriting them would falsify history |

Total occurrences: **349 → 298**. Of the 298 remaining, **48** are in dated
historical report files and **250** are in active files — of those 250, **249 are
technical identifiers** and **1** is the historical CHANGELOG literal below.

---

## Retained legacy identifiers (intentional — compatibility, NOT branding)

| Identifier | Where | Why it must not change |
| --- | --- | --- |
| `JWT_ISSUER` default `netsphere` | `backend/src/config/index.ts`, `.env*.example`, `algVerify.test.ts` | The JWT `iss` claim. Changing it invalidates every already-issued token → forced logout / broken validation |
| Salt `netsphere/credential-secret/v1` | `backend/src/crypto/secretBox.ts` | AES-256-GCM key-derivation salt. Changing it makes **all existing encrypted credential secrets undecryptable** |
| Bundle id `io.netsphere.terminal` | `tauri.conf.json`, `keyring.rs` (`SERVICE`) | OS app identity + OS keyring account. Changing it orphans stored credentials and changes app identity |
| `~/.netsphere/known_hosts` | `known_hosts.rs` | Host-key TOFU store. Changing the path loses trusted host keys → spurious "host key changed" blocks |
| `localStorage` keys `netsphere.*` (`refresh_token`, `lock`, `theme`, `branding`, `terminal-ui`, `terminal-tabs`, `terminal-paste`, `saveCommandHistory`, `ai-hint-off`) | `desktop/src/**` | Per-browser persisted state incl. the refresh token + legacy-key migration. Renaming logs users out / drops preferences |
| Package/crate names `netsphere-auth-service`, `netsphere-terminal-desktop`, `netsphere-terminal`, `netsphere_terminal_lib` (+ lockfiles) | `package.json`, `Cargo.toml`, lockfiles, `main.rs` | npm/cargo identifiers and the deb bundle filename; `main.rs` calls the lib crate by name |
| Docker resources `netsphere-postgres/redis/auth/vpn-helper`, network `netsphere-internal`, volumes `netsphere-*-data/-run`, images `netsphere/auth-service`,`netsphere/vpn-helper` | `docker-compose.production.yml`, `deployments/docker-compose.yml`, deploy scripts/tests | Operational resource names; the installer/updater + gateway-trust discovery reference `netsphere-auth`/`netsphere-internal` by name |
| Env var `NETSPHERE_DOMAIN` | `install.sh`, `update.sh`, `evidence.sh`, docs, tests | Env-var contract, not branding — renaming breaks existing operator scripts/automation |
| DB user/name `netsphere`, admin login `admin@netsphere.local` | `generate-secrets.sh`, `.env*.example`, compose, README | DB role/name and the bootstrap admin login identifier |
| nginx site paths `/etc/nginx/sites-available/netsphere`(`-bootstrap`), unit file `netsphere.service`, logs `/var/log/nginx/netsphere-*.log`, `/var/log/netsphere-backup.log` | deploy scripts, `netsphere.conf`, docs | Filesystem/service paths referenced consistently by the installer and existing installs |
| **Substitution token** `netsphere.example.com` | `deploy/nginx/netsphere.conf`, `evidence.sh` (`render_nginx_config` `gsub`), `.env.production.example`, deploy README `sed` | It is a **template placeholder** literally replaced with the operator's real domain at install time (`gsub(/netsphere\.example\.com/, dom)`). Operators never see it in a deployed config. Changing it in one place without the coupled `gsub` breaks domain substitution |
| Backup file prefix `netsphere-<ts>.sql.gz` | `backup.sh`, `restore.sh`, docs | Existing backups + the `-mtime` cleanup `find` match this prefix |
| `APP_NAME` default `netsphere` | `backend/src/config/index.ts`, `.env.example` | Unused config default (not rendered anywhere); left untouched to avoid changing config semantics |

### Historical-record retention (active file)
| Occurrence | File:line | Why retained |
| --- | --- | --- |
| `the app name showed **"NetSphere"** before the configured name` | `CHANGELOG.md:1280` | A dated changelog entry describing a **past** bug where the literal old default value was the string `"NetSphere"`. Rewriting it would make the historical record factually wrong |

Dated engineering/security reports (`FINAL_*.md`, `PHASE_*.md`, `*_BASELINE.md`) keep
their original `Awamer / NetSphere Terminal` wording as point-in-time records.

---

## Final branding scan (after edits)

```
grep -RniE 'netsphere|net[[:space:]]+sphere' .    (excl. node_modules/.git/dist/build/target)
  Before: 349    After: 298
  Remaining, classified:
    • 48  — dated historical report files (records; retained)
    • 249 — technical identifiers in active source/config/deploy (retained; table above)
    •  1  — CHANGELOG historical literal-value record (retained)
  Remaining that are user-facing product-name branding: 0

grep -rnE 'NetSphere|Net Sphere' .  (active files only, excl. dated reports)
  → 1 match: CHANGELOG.md:1280 (historical literal value — intentional)
```

**Runtime branding verification**

| Surface | Value now |
| --- | --- |
| Browser tab / built `dist/index.html` `<title>` | **Awamer Terminal** (verified in build output) |
| Default in-app name (`branding.tsx` fallback / `VITE_APP_NAME`) | **Awamer Terminal** |
| Desktop window title + `productName` (Tauri) | **Awamer Terminal** |
| Startup log banner | `Awamer Terminal starting` |
| API docs (Swagger, when `ENABLE_API_DOCS=true`) | **Awamer Terminal API** |
| Installer completion banner | `Awamer Terminal installation complete.` |
| systemd unit `Description` | `Awamer Terminal backend stack` |
| In-app error/help text | "…require the **Awamer** desktop app.", "…key than the one **Awamer** has on file." |

(The About/login/header/sidebar render `useAppName()`, which resolves to the
server-configured brand or the new **Awamer Terminal** default.)

---

## Regression (all green — functionality unchanged)

| Suite | Result |
| --- | --- |
| Backend `npx tsc --noEmit` | **clean** |
| Backend `npm test` (unit) | **263 / 0** |
| Desktop `npx tsc --noEmit` | **clean** |
| Desktop `vitest` | **23 / 0** (incl. keyring storage-key tests — retained keys still match) |
| Desktop `npm run build` | **success** (title = Awamer Terminal) |
| Deploy `proxy-deploy-test` | **11 / 0** |
| Deploy `evidence-test` | **31 / 0** |
| `bash -n` on all edited shell scripts | **OK** |

No test was weakened, skipped, or disabled. `algVerify.test.ts` (JWT issuer
`netsphere`) and `keyring.test.ts` (`netsphere.*` storage keys) pass unchanged —
proof the retained identifiers were left intact.

---

## Non-goals confirmed NOT altered

Authentication, Authorization/RBAC (no permission added or changed), Tenant
isolation, MFA/step-up, JWT/session logic, SSH/Telnet/VNC/RDP, VPN / Multi-VPN /
firewall / rollback, Database schema/migrations/roles, Networking/SSRF/proxy-trust,
credential encryption, and installation security — **untouched**. The only backend
source edits are a Swagger doc **title string** (`server.ts`) and one **comment**
(`vnc/gateway.ts`); `config/index.ts` and `secretBox.ts` were deliberately left
unchanged. Diff: **40 files, +92 / −61**, all branding text/comments.
