# Changelog

All notable changes to NetSphere Terminal are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Policy:** every release appends to this file. Entries are never deleted.

---

## [1.7.0] — 2026-05-26 — Monaco editor + chmod/chown UI

### Added
- **Monaco editor** replaces the plain textarea in the SFTP inline
  editor. Loaded lazily (`React.lazy` + `Suspense`) so the ~3 MB
  bundle is only fetched the first time the user opens a file. The
  1 MB edit limit is unchanged.
- **Filename → language detection** for syntax highlighting:
  ts/tsx, js/jsx, json, yaml, toml (as ini), md, py, rs, go, rb, php,
  java, kt, swift, c/h, cpp/cc/hpp, cs, sh/bash, sql, html, css,
  scss, conf/ini, dockerfile, makefile. Unknowns render as
  `plaintext` — still editable, just no highlighting.
- **Permissions modal (chmod / chown)** reachable from per-row hover
  action and right-click context menu. Lets the user edit mode in
  octal **or** via a 3×3 grid of r/w/x checkboxes (both bound to the
  same value), and set uid/gid numerically. Blank uid/gid means
  "leave that side unchanged". After a successful write the listing
  refreshes so the new mode/owner appears immediately.
- **Rust commands:** `sftp_chmod(session_id, path, mode)` and
  `sftp_chown(session_id, path, uid, gid)`. Both go through
  `russh-sftp`'s `set_metadata` with only the fields they intend to
  change, so SETSTAT's wire bitmask only touches the requested
  attributes. `chmod` masks `mode & 0o7777` defensively.
- **`RemoteEntry.uid` / `.gid`** now returned by `sftp_list` so the
  Permissions modal can show current owner/group.

### Changed
- `RemoteEntry` (TS + Rust) gains `uid: Option<u32>` and
  `gid: Option<u32>` — additive, existing consumers ignore them.

### Risks
- `russh-sftp` write API surface still not compile-verified in the
  sandbox (same caveat as 1.5.0 / 1.6.0). `set_metadata` and
  `FileAttributes` field names are the documented public API for
  the 2.0 crate, but a follow-up `cargo check` on a developer
  machine is the surest validation.
- chown via SFTP needs **numeric** uid/gid by design — name → id
  translation would require either an extra shell round-trip or
  scraping `/etc/passwd`. Both deferred; the UI shows current
  numeric ids as placeholders.

### Known limitations
- No bulk chmod across multiple selected files (single-entry only).
- chown is silently a no-op when the SFTP server (or POSIX
  permissions) refuses the request — we surface the server error
  text but cannot detect "user lacks privilege" upfront.

---

## [1.6.1] — 2026-05-26 — SFTP dialog plugin fix

### Fixed
- **Desktop SFTP page no longer throws `Cannot read properties of
  undefined (reading 'invoke')`** when opening the Save / Upload
  pickers. Root cause: the `@tauri-apps/plugin-dialog` npm wrapper
  imports `invoke` from `@tauri-apps/api/core`, and on some Tauri 2.x
  layouts that import resolved to a duplicate copy whose internal IPC
  binding was undefined. We now call the dialog plugin's IPC commands
  (`plugin:dialog|save`, `plugin:dialog|open`) directly through the
  same `invoke` already in use elsewhere on the page — one resolution
  path, no duplicate module.

### Removed
- `@tauri-apps/plugin-dialog` from `desktop/package.json` (no longer a
  runtime dependency — the Rust-side `tauri-plugin-dialog` continues to
  serve the IPC commands)

### Notes
- No protocol change. Existing builds with the npm wrapper still work;
  this release just eliminates the failure mode.
- Capabilities (`dialog:default`, `dialog:allow-save`,
  `dialog:allow-open`) are unchanged.
## [1.7.0] — 2026-05-29 — Phase 4 polish: chmod, recursive download, search & sort (+ 1.6.1 dialog fix)

### Fixed
- **SFTP file dialogs no longer crash with `Cannot read properties of
  undefined (reading 'invoke')`.** The renderer previously called
  `save()` / `open()` from the JS `@tauri-apps/plugin-dialog` package.
  On some Tauri 2.x setups that plugin's bundled `@tauri-apps/api`
  drifts from the app's and its internal `invoke` reference resolves off
  an `undefined` global. We now drive the native dialogs from Rust via
  new `dialog_save_file` / `dialog_open_file` / `dialog_pick_folder`
  IPC commands (the Rust `tauri-plugin-dialog` API is stable across the
  2.x line). The JS `@tauri-apps/plugin-dialog` dependency was removed
  entirely so the failure mode can't recur. (This is the fix that was
  tracked as 1.6.1.)
- **Invalid crate version `1.6.0.1`** in `desktop/src-tauri/Cargo.toml`
  is not valid SemVer (four components) and made `cargo` refuse to even
  parse the manifest — the desktop client could not build from a clean
  checkout. Bumped to a valid `1.7.0` across `Cargo.toml`,
  `package.json`, and `tauri.conf.json`.

### Added
- **chmod / permissions UI.** Right-click → *Permissions…* (or the
  shield icon on row hover) opens an editor with an owner/group/other ×
  read/write/execute checkbox grid kept in sync with an octal field.
  Backed by a new `sftp_chmod` command that issues a pure SETSTAT
  carrying only the permission bits (so it can never accidentally
  truncate the file).
- **Recursive folder download.** Directories now have a *Download
  folder* action that picks a local destination and mirrors the remote
  tree beneath it, streaming aggregate progress over the existing
  transfer channel. Backed by `sftp_download_dir`, which pre-walks the
  tree to compute the total byte count first so the progress bar is
  accurate.
- **Filter current directory.** A search box in the toolbar filters the
  listing by name as you type.
- **Sortable columns.** Click the Name / Size / Modified headers to sort
  (click again to reverse). Directories stay grouped above files.

### Known issues
- `chmod`/`chown` ownership (uid/gid) editing is not exposed — only
  permission bits. Changing owner usually needs root and is deferred.
- Cross-host copy/move is still deferred to a later release.

---

## [1.6.0.1] — 2026-05-26 — Production deployment package + recurring fixes

### Fixed
- **Permanent fix for `Vec::with_capacity(ReadDir::len())`** — the
  russh-sftp `ReadDir` is an iterator, not a Vec, so `.len()` doesn't
  exist. Replaced with `Vec::new()` once and for all. This bug was
  patched in-place in 1.5.0 and 1.6.0 but was lost across re-extracts.
- **Permanent fix for `let mut channel` warning** — variable is never
  reassigned, so the `mut` was always unnecessary.

### Added
- **`deploy/` directory with full production tooling:**
  - `docker-compose.production.yml` — strict-secrets compose file
    (refuses to start if env vars missing); named volumes; bound to
    127.0.0.1 so nginx is mandatory
  - `nginx/netsphere.conf` — reverse proxy + HSTS + security headers
  - `scripts/install.sh` — one-shot Ubuntu installer (Docker, nginx,
    certbot, secret generation, all in one interactive script)
  - `scripts/generate-secrets.sh` — produces a complete env file with
    cryptographically random JWT, MFA, DB, Redis secrets
  - `scripts/backup.sh` + `scripts/restore.sh` — Postgres dump/restore
  - `systemd/netsphere.service` — auto-start on boot
  - `README.md` — comprehensive deployment guide including rollback,
    secret rotation, troubleshooting, security checklist
- `.env.production.example` template
- Resource cleanup: production stack pins APP_VERSION tag, uses named
  volumes (`netsphere-postgres-data`, `netsphere-redis-data`)

### Security
- Production compose binds postgres + redis to **internal network
  only** (no host ports)
- Backend bound to `127.0.0.1:8081` — nginx is the only public face
- Strict-secrets pattern: compose refuses to start if any of these
  are missing: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `MFA_ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`
- `.env.production` file mode 600 enforced by install.sh
- nginx config sets HSTS, X-Frame-Options DENY, X-Content-Type-Options
  nosniff, Referrer-Policy no-referrer, Permissions-Policy minimal

### Known issues (not blocking deployment)
- Desktop SFTP page may throw `Cannot read properties of undefined
  (reading 'invoke')` on some Tauri 2.x configurations due to
  `@tauri-apps/plugin-dialog` version mismatch. Does not affect
  server deployment; affects only the desktop client. Workaround
  pending in 1.6.1.

---

## [1.6.0] — 2026-05-12 — Phase 4b: SFTP write operations

### Added
- 7 new SFTP IPC commands: `sftp_rename`, `sftp_remove_file`,
  `sftp_remove_dir`, `sftp_mkdir`, `sftp_read_text`,
  `sftp_write_text`, `sftp_upload`
- Recursive directory deletion using boxed async-fn pattern
- Drag-and-drop upload from desktop file managers (with HTML5 + native
  Tauri event-channel fallback)
- Per-row hover actions: edit, download, rename, delete
- Right-click context menu on file/folder entries
- Inline text editor for files ≤ 1 MB (plain textarea — Monaco
  deferred to 1.7.0)
- Toolbar with Refresh, New folder, Upload buttons
- Combined upload/download progress tray with direction-specific icons

### Changed
- `DownloadState` → `TransferState` (now covers uploads too)
- `DownloadRow` component → `TransferRow`
- Upload progress reuses the same `sftp:progress:{sid}` event channel
  as downloads — renderer doesn't need to distinguish

### Risks
- russh-sftp write API surface not compile-verified in sandbox
- Tauri 2.x `tauri://drag-drop` event channel name may differ
- File-edit limit hard-coded at 1 MB — configurable later if needed

### Known limitations
- No chmod / chown UI (display-only mode bits)
- No recursive folder download (use per-file)
- No host-to-host transfers (all routes through local)
- No syntax highlighting in editor

---

## [1.5.0] — 2026-05-12 — Phase 4a: SFTP file browser (browse + download)

### Added
- Rust SFTP module `commands/sftp.rs` built on `russh-sftp = "2.0"`
- 5 new IPC commands: `sftp_connect`, `sftp_list`, `sftp_download`,
  `sftp_disconnect`, `sftp_list_sessions`
- Independent SFTP session registry (separate from terminal sessions)
- Re-uses `known_hosts` store for TOFU verification across protocols
- React SFTP browser page `SftpPage.tsx` (~430 lines) with path breadcrumb,
  sorted file table, per-file download with progress
- Route `/hosts/:id/sftp`
- "SFTP" button on HostDetailPage's Connect card
- `tauri-plugin-dialog` for system save dialogs
- Capabilities permissions: `dialog:default`, `dialog:allow-save`,
  `dialog:allow-open`

### Changed
- `ssh.rs` helpers (`fetch_host`, `fetch_credential*`, `HostJson`,
  `CredentialJson`) promoted to `pub(crate)` for re-use from sftp.rs

### Known limitations (deferred to 1.6.0+)
- Read-only browsing in 1.5.0; upload/rename/delete/edit in 1.6.0
- No recursive folder download
- No drag-drop
- chmod/chown reserved for 1.7.0

### Risks
- russh-sftp API not compile-verified in sandbox
- Auth path is duplicated between ssh.rs and sftp.rs pending refactor

---

## [1.4.0] — 2026-05-11 — Phase 3 Polish (Continuity)

### Added
- Tab persistence via `zustand/persist` + localStorage. Tab identity
  (id, hostId, label) survives app restarts; runtime state (sessionId,
  phase, errors) is reset on rehydrate.
- Reconnect button on disconnected terminal tabs (centered overlay
  for rehydrated tabs without an xterm; header button for tabs that
  lost a live session).
- SSH agent auth via `AuthMethod::SshAgent` in the Rust SSH connector.
  Connects to `$SSH_AUTH_SOCK`, lists identities via russh's agent
  client, and tries each until one is accepted.
- Five new error codes: `ssh_agent_unavailable`, `ssh_agent_connect_failed`,
  `ssh_agent_query_failed`, `ssh_agent_no_identities`,
  `ssh_agent_auth_failed`.
- Real 8-bit RGBA PNG icons shipped in the tarball at all sizes
  required by Tauri. No more `convert PNG32:` workaround after extract.

### Changed
- `TerminalPane` mount-time auto-connect skips rehydrated tabs that
  start in `disconnected` phase, avoiding a wall of password prompts
  when opening the app.

### Decisions
- Deferred: full automatic reconnect on network drop. Rationale in
  RELEASE_NOTES.md — SSH was not designed to survive network drops,
  and silently re-establishing loses shell state. Recommended
  workaround: wrap remote work in `tmux`/`screen`.

### Known limitations
- ssh-agent on Windows untested (Windows uses named pipes not Unix
  sockets; russh's agent client targets Unix sockets).
- Tab persistence is per-origin in localStorage.

### Risks
- Rust agent-client API not compile-verified in the sandbox; may need
  a small patch if `AgentClient::connect_uds` or `authenticate_future`
  have drifted.

---

## [1.3.1] — 2026-05-11 — Disable MFA in-app

### Added
- Backend route `POST /api/v1/auth/mfa/disable` (password-confirmed)
- `MFAUseCase.disable(userId, password)` with argon2 verification
  and audit logging
- Desktop `authApi.mfaDisable(password)` client method
- Desktop `authStore.refreshUser()` action to sync local user state
  after MFA toggle
- "Disable two-factor authentication" UI in Settings → Security →
  Two-factor authentication, with password confirmation modal

### Changed
- Constructor of `MFAUseCase` now takes an additional `Argon2Service`
  parameter (for password verification on disable). Server wiring
  updated to pass it.

### Security
- Disable action requires the current password as re-auth — stops
  stolen access tokens from being enough to weaken account MFA.
- Audit log records every disable attempt (success or wrong-password).

---

## [1.3.0] — 2026-05-11 — Phase 3b: SSH keys, TOFU, multi-tab

### Added
- Private-key authentication via `russh_keys::decode_secret_key` +
  `authenticate_publickey`. Supports OpenSSH, PEM, and other formats
  russh decodes. Encrypted keys prompt for passphrase at connect time.
- TOFU host-key verification with OpenSSH-compatible
  `~/.netsphere/known_hosts` file.
- New Rust module `commands/known_hosts.rs` (parse, lookup, add,
  forget, fingerprint).
- New IPC commands: `ssh_get_known_host`, `ssh_forget_known_host`,
  `ssh_list_known_hosts`.
- Multi-tab terminal UI: `TerminalWorkspace` (tab bar) +
  `TerminalPane` (per-tab xterm). Zustand store
  `terminalTabsStore` for tab list state.
- HostDetailPage shows TOFU fingerprint + Forget button.
- Sidebar entry "Terminal" for navigating back to active tabs.
- Rust crates: `base64 = 0.22`, `sha2 = 0.10`, `dirs = 5.0`.

### Changed
- `ssh_connect` accepts a `passphrase` field for encrypted keys.
- `ClientHandler` now consults the known_hosts store; rejects on
  key mismatch with a structured `host_key_changed` payload.
- Connect button on HostDetailPage opens a TAB (or focuses existing)
  via the new workspace, not a single-page terminal.

### Removed
- `modules/sessions/components/TerminalPage.tsx` (replaced by
  TerminalWorkspace + TerminalPane).

### Security
- Hard-block on host key mismatch — no "proceed anyway" option.
- Passphrases held in memory only; not written to disk or DB by
  default. (Optional fallback: store in credential `secret_data`.)
- `~/.netsphere/known_hosts` written with mode 0o600.

### Known limitations
- Tabs do not persist across app restarts (1.4.0).
- No automatic reconnect on network drop (1.4.0).
- No ssh-agent / `~/.ssh/config` import (1.4.0).
- Hashed known_hosts entries (OpenSSH `|1|...`) are preserved on
  rewrite but ignored for matching.

---

## [1.2.0] — 2026-05-11 — Phase 3a: SSH terminal (password auth)

### Added
- Rust SSH client module `src-tauri/src/commands/ssh.rs` built on
  `russh = "0.45"`
- 4 new Tauri IPC commands: `ssh_connect`, `ssh_write`, `ssh_resize`,
  `ssh_disconnect`
- Per-session output streaming via Tauri events (`ssh:event:{sid}`)
- Process-wide session registry (lazy-initialised `Mutex<HashMap>`)
- `AppError` structured error type for IPC commands
- HTTP client (`reqwest` + rustls) for credential lookup and history
  recording from within the Tauri process
- `desktop/src/modules/sessions/components/TerminalPage.tsx` — xterm.js
  terminal with credential prompt and connection-state UI
- xterm.js packages: `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-web-links`
- Route `/hosts/:id/terminal`
- Host Detail's **Connect** button now navigates to the terminal for SSH
  hosts (disabled for non-SSH protocols)

### Changed
- Connect button on HostDetailPage was "Coming in Phase 3" → now active
  for SSH

### Known limitations (deferred to 1.3.0+)
- Password authentication only; private_key/certificate/agent rejected
- No host-key verification (TOFU); accepts any server key
- One session at a time (no tab UI yet); backend supports multi-session
- No automatic reconnect on network drop

### Risks
- Rust code was not compile-tested in the build sandbox (toolchain
  installer blocked). Desktop TypeScript typechecks clean. Compile
  errors from `cargo build` will be patched in 1.2.0.1.

---

## [1.1.2] — 2026-05-11 — Host list 500 fix

### Fixed
- **`GET /api/v1/hosts` returned 500 with PG error `bind message supplies 3
  parameters, but prepared statement requires 1`.** Cause: `HostRepository.list`
  reused a single mutable `params` array for both the count and the list
  queries, then pushed `limit, offset` onto it between the two `.query()`
  calls. Because both calls were awaited together via `Promise.all`, both saw
  the post-mutation array — but the count query only had placeholders for
  the WHERE clause. Result: bind mismatch, query failed, the entire Hosts
  page rendered "Internal Server Error" (since the page Promise.all's three
  fetches and any failure short-circuits the success branch).
- Same bug existed in `ConnectionHistoryRepository.list`; fixed in the
  same patch so `/api/v1/history` doesn't trip the same way under
  similar conditions.

### Implementation note
Each query now builds its own parameter array via spread (`[...params]`
for count, `[...params, limit, offset]` for list). The `userRepo.list`
method was already doing this correctly and was not affected.

---

## [1.1.1] — 2026-05-11 — MFA activation crash fix

### Fixed
- **Desktop crash after activating MFA, on next sign-in:** the auth store
  read `res.user.id` from the login response, but the backend's
  MFA-required login response (`{mfa_required, mfa_token}`) didn't include
  a `user` object — producing `Cannot read properties of undefined (reading 'id')`.
  - Backend (`routes/auth.ts`): MFA-required login now includes a minimal
    `user` payload (via `userView`) so the MFA prompt screen can greet the
    user by name.
  - Desktop (`authStore.ts` + `authApi.ts`): `user` is now treated as
    optional on `LoginResponse`; the auth store guards with
    `res.user?.id ?? null`. Either change alone would fix the crash;
    shipping both makes the contract more forgiving.

---

## [1.1.0] — 2026-05-11 — Phase 2: Session Management

### Added
- Migration `005_session_management`: tables `folders`, `tags`, `credentials`,
  `hosts`, `host_tags`, `connection_history`; enum types `host_protocol`,
  `credential_type`, `connection_status`
- `audit_action` enum extended: `host_create/update/delete`,
  `folder_create/update/delete`, `tag_create/update/delete`,
  `connection_start/end`
- Domain types in `src/domain/session.ts` (Host, Folder, Tag, Credential,
  ConnectionHistoryEntry, DEFAULT_PORTS map, type guards)
- 5 new repositories in `src/repos/sessionRepos.ts`
- Fastify route plugins: `/folders`, `/tags`, `/credentials`, `/hosts`,
  `/history` (23 endpoints total)
- Host repository with tag M2M operations, folder cycle detection,
  full-text search via trigram index, paginated list with filters
- ConnectionHistoryRepository with append-only semantics + host-name
  denormalization (deletes preserve trail)
- Desktop module `modules/sessions/` with API client and 6 React pages:
  HostsPage, HostFormPage, HostDetailPage, CredentialsPage, TagsPage,
  FoldersPage
- Sidebar nav: Workspace section now Hosts/Credentials/Folders/Tags;
  Files/Network/Audit moved to "Coming soon"
- `src/vite-env.d.ts` with `ImportMetaEnv` for `VITE_API_BASE_URL` typing

### Changed
- DashboardLayout sidebar reorganized; old "Sessions" placeholder removed in
  favor of concrete Hosts page
- App router: 7 new routes under protected shell

### Fixed
- Pre-existing TS2339 error in `shared/lib/api.ts:15` for `import.meta.env`
  (latent in 1.0.0, masked by other compile output)
- Strict-mode regex match destructuring in `migrate.ts` (`noUncheckedIndexedAccess`)

### Security
- Credentials repository scrubs `secret_data` from list responses; only
  visible via `GET /credentials/:id?reveal=true` which is audit-logged
- All session-management queries are user-scoped at the SQL level — a user
  can never read/modify another user's hosts, folders, tags, credentials,
  or history

### Known issues
- Credential secrets stored as plaintext JSONB. Phase 10 will encrypt at
  rest. Marked `TODO(Phase10)` in migration 005.
- No drag-and-drop folder reorganization (use the parent dropdown in folder
  edit form)
- No bulk import from PuTTY / OpenSSH config / mRemoteNG (Phase 2.x)
- `ALTER TYPE ADD VALUE` is non-reversible in PostgreSQL; rolling back
  migration 005 leaves the new audit_action enum values in place

---

## [1.0.0] — 2026-05-10 — Phase 1: Foundation

### Added
- Node.js / TypeScript / Fastify auth-service
- PostgreSQL 16 schema (users, mfa_devices, refresh_sessions, audit_logs,
  permissions, role_permissions, devices, user_settings)
- Tauri + React + TypeScript desktop app shell
- Argon2id password hashing (m=64 MiB, t=3, p=4)
- TOTP MFA enrollment + verification
- Refresh-token rotation with chain-revocation reuse detection
- Admin-only user CRUD endpoints
- Settings (theme, language, profile)
- Bootstrap-on-startup admin: hashes `BOOTSTRAP_ADMIN_PASSWORD` at runtime
  if the users table is empty
- Docker Compose stack: postgres + redis + auth-service
- Makefile with relative paths (safe for paths containing spaces)
- Comprehensive troubleshooting guide in README
- RELEASE_NOTES.md tracking every issue and fix

### Fixed (during 1.0.0-rc → 1.0.0)
- Backend rewritten from Go to Node.js to eliminate pgx CITEXT decoding bug
- Migration 002 uses TEXT instead of CITEXT
- Removed baked-in SQL admin hash (caused dollar-escaping corruption)
- Makefile no longer uses `$(CURDIR)` (broke on paths with spaces)
- docker-compose `--env-file` now passed explicitly
- Removed obsolete `version: "3.9"` key from docker-compose
- api-gateway moved behind `gateway` profile so it doesn't break default builds
- Dockerfile builds run `go mod tidy` (Go era) / `npm install` cleanly without
  pre-generated lockfiles
- Desktop `mfaConfirm` renamed to `mfaActivate` to match backend route

### Changed
- Backend stack: Go + Echo → Node.js + Fastify
- Database username column: CITEXT → TEXT (case-insensitivity in application)
- Admin seeding: SQL migration → process bootstrap
- Default admin password environment variable: `BOOTSTRAP_ADMIN_PASSWORD`

### Removed
- Migration 005 (seed admin) — replaced by bootstrap-on-startup
- Go module files (go.mod, go.sum) — backend is Node.js
- `api-gateway` from default compose services — opt-in profile only

### Security
- Argon2id parameters tuned for ~300 ms verify on modern hardware
- Failed login attempts increment a counter; account locked at threshold (default 5)
- Refresh tokens single-use; reuse revokes entire token family
- JWT access and refresh secrets must differ
- Production guard rejects dev-only JWT secrets in `APP_ENV=production`

### Known issues
- Self-service password change UI is stubbed (Phase 2)
- TOTP secret stored unencrypted (Phase 10)
- Tauri icons are 1×1 placeholders
- macOS/Windows builds untested

---

[Unreleased]: https://github.com/your-org/netsphere-terminal/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/your-org/netsphere-terminal/releases/tag/v1.0.0
