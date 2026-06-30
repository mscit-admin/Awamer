# Changelog

All notable changes to NetSphere Terminal are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Policy:** every release appends to this file. Entries are never deleted.

---

## [1.33.1] — 2026-06-29 — Terminal survives navigation

### Fixed
- **SSH terminal sessions no longer drop when you switch screens.** The
  terminal workspace is now mounted persistently in the app shell and merely
  hidden when you navigate to Credentials, Settings, etc. — so its WebSocket
  sessions, scrollback and running work stay alive when you come back. It's
  still lazy-loaded (xterm only downloads on first terminal use), and xterm
  refits automatically when the terminal becomes visible again.

---

## [1.33.0] — 2026-06-29 — Command-history permission

### Added
- **`command_history:read` permission** — controls who can save & view their own
  terminal command history (previously gated by `sessions:connect`). It appears
  in **Roles & Permissions** and can be granted per role.
  - migration `011_command_history_perm` grants it to the built-in
    super_admin / admin / user roles (parity with prior behavior); read-only and
    auditor don't get it.
  - server: command-history routes now require `command_history:read`.
  - UI: the terminal's **Save history / History** controls only show for users
    with the permission (and nothing is captured without it).

---

## [1.32.0] — 2026-06-29 — Share notes with other users

### Added
- **Note sharing.** A note's owner can share it **with everyone** or with
  **specific users**; recipients see it (read-only) on their Notes page with a
  "shared by …" badge. Mirrors host sharing.
  - migration `010_note_shares` (`notes.is_shared` + `note_shares` table).
  - notes list visibility = own OR shared-with-everyone OR shared-with-you;
    edit/delete/pin remain **owner-only** (recipients can't modify).
  - `PATCH /api/v1/notes/:id` accepts `is_shared`; `GET/PUT
    /api/v1/notes/:id/shares` manage the per-user list (owner only).
  - frontend: a **Share** dialog on owned notes (everyone toggle + user
    checklist); shared/owner badges in the list.
  - verified end-to-end against PostgreSQL 16 (visibility for owner/specific/
    everyone, recipient read-only, share-id management, unshare).

---

## [1.31.1] — 2026-06-29 — Faster load (code-splitting)

### Changed
- **Code-split the frontend.** Routes now lazy-load, so heavy libraries
  (xterm, noVNC, Monaco editor, kdbxweb + hash-wasm) download only when their
  page is opened instead of all upfront. Initial JS dropped from one ~1.2 MB
  bundle to ~0.28 MB + small per-route chunks — much faster first load and
  navigation. The login/dashboard shell stays eager so sign-in is instant.

---

## [1.31.0] — 2026-06-29 — Notes

### Added
- **Notes** — a personal, per-user notes screen (sidebar → Notes): create, edit,
  pin, search and delete notes. Each note can have a title + body.
  - migration `009_notes` (per-user; optional `host_id` with a `host_label`
    snapshot) + `NotesRepository`; `GET/POST/PATCH/DELETE /api/v1/notes`
    (self-scoped, any signed-in user).
  - **Quick notes from the terminal**: a **Notes** button in the web terminal
    toolbar opens a slide-over scoped to the current host — notes you take there
    are tagged with that host and show up on the Notes page with a host badge.
  - verified end-to-end against PostgreSQL 16 (CRUD, host filter, search, pin
    ordering, per-user isolation).

---

## [1.30.1] — 2026-06-29 — Drag assets into folders

### Added
- **Drag-and-drop an asset onto a folder** (or "Unfiled") in the Assets sidebar
  to move it — drop targets highlight while dragging. Persists via the host's
  `folder_id`; only your own editable assets are draggable (needs
  `resources:write`).

---

## [1.30.0] — 2026-06-29 — Configurable reset-email content & expiry

### Added
- **Password-reset email is now configurable** from SMTP settings:
  - **Link validity (minutes)** — replaces the hardcoded 1 hour (5–1440).
  - **Subject** and **Message body** with placeholders
    <span>`{{link}}`</span> (the reset URL) and <span>`{{minutes}}`</span>
    (validity). The body is sent as plain text and an HTML version (the link
    becomes a clickable, HTML-escaped anchor). Blank fields fall back to
    sensible defaults.

---

## [1.29.1] — 2026-06-29 — Readable API errors + SMTP TLS option

### Fixed
- **API error messages showed "[object Object]".** The client stringified the
  whole `{ code, message }` error object instead of its `message`. Now it reads
  `error.message` (falling back to `code` / Fastify's `message`), so real error
  text shows everywhere — including the SMTP **Send test** result.

### Added
- **SMTP "Allow self-signed / invalid TLS certificate"** option, for
  self-hosted mail servers whose certificate doesn't validate
  (`tls.rejectUnauthorized=false` when enabled).

---

## [1.29.0] — 2026-06-28 — Password reset by email + SMTP config

### Added
- **SMTP configuration** under Administration (admin / super_admin). Set host,
  port, TLS, username, password, From address and the app base URL; send a
  **test email**. Stored in `app_settings`; the SMTP password is **encrypted at
  rest** (SecretBox) and never returned to the client.
  - `GET/PUT /api/v1/admin/smtp`, `POST /api/v1/admin/smtp/test`.
- **Forgot / reset password by email.**
  - migration `008_password_resets` — one-time, 1-hour, single-use tokens
    (only the SHA-256 hash is stored).
  - `POST /api/v1/auth/forgot-password` (always 200 — never reveals whether an
    email exists) emails a reset link; `POST /api/v1/auth/reset-password`
    validates the token, sets the new password (policy-checked), consumes the
    token and revokes all refresh sessions.
  - frontend: **Forgot password?** link on the sign-in screen →
    `/forgot-password`; `/reset-password?token=…` page to choose a new password.
  - verified end-to-end against PostgreSQL 16: token issue/consume, single-use,
    weak-password & invalid-token rejection, unknown-email silence, session
    revocation.
- New backend dependency: `nodemailer`.

### Notes
- SMTP is gated by the **admin role** (consistent with Branding — instance
  infrastructure), not a per-user permission.

---

## [1.28.0] — 2026-06-28 — Login background image & draggable sign-in card

### Added
- **Login background image**, configurable from the **Branding** screen
  (alongside name/logo/favicon). Stored server-side (`app_login_image`,
  data URI or URL, up to ~3 MB) and shown behind the sign-in card with a
  subtle blur/overlay for legibility.
- **Draggable sign-in card.** The login panel is now a floating card you can
  reposition by dragging its header (pointer-capture drag; the form fields stay
  fully usable).
- `GET/PUT /api/v1/branding` now carry `login_image` (PUT body limit raised to
  4 MB for the larger image).

---

## [1.27.0] — 2026-06-28 — Telnet (browser terminal)

### Added
- **Browser Telnet.** Connect to a Telnet host from the asset's **Connect**
  button — an interactive xterm.js terminal over a backend WebSocket↔TCP relay
  (`/api/v1/telnet/connect`), gated by `sessions:connect`. Telnet option
  negotiation (IAC) is handled server-side (accepts ECHO/SGA, refuses the rest,
  strips subnegotiation) so the terminal only sees clean output; the login
  happens in-stream. Connection history is recorded like SSH/VNC.
  - verified: IAC negotiation unit tests (ECHO/SGA accept, others refused,
    escaped 0xFF, subnegotiation stripping, sequences split across chunks).

### Notes
- **RDP** and **Serial** remain unsupported: RDP needs a Guacamole-style
  gateway (a separate `guacd` service), and Serial requires host-attached
  hardware (or the browser Web Serial API) — both are larger, separate efforts.

---

## [1.26.1] — 2026-06-28 — Connect action for SFTP/HTTP assets

### Fixed
- The host detail **Connect to host** card showed "Not yet supported" for
  `sftp` assets even though the browser SFTP browser exists. It now offers
  **Browse files** for `sftp` hosts, **Open** (new tab) for `http`/`https`
  hosts, alongside the existing SSH (terminal + SFTP) and VNC actions. Only
  genuinely unimplemented protocols (rdp, telnet, serial, custom) still show
  "Not supported yet".

---

## [1.26.0] — 2026-06-28 — Asset logos

### Added
- **Per-asset logo.** Upload a custom logo/icon for a host on the asset form
  (PNG/SVG/JPG up to 256 KB). It's shown on the Assets list cards and the host
  detail header, falling back to the protocol icon when none is set. Stored in
  the host's `options` (data URI) — no migration or new permission (gated by the
  existing `resources:write` for editing hosts).

---

## [1.25.0] — 2026-06-28 — Import from KeePass (.kdbx)

### Added
- **KeePass import.** Import an existing `.kdbx` database into the app from the
  **Credentials → Import from KeePass** screen.
  - The file is **decrypted entirely in the browser** (`kdbxweb` + `hash-wasm`
    Argon2, supporting KDBX 3.x and KDBX4) — the master password and secrets
    never leave the device; only the resulting credentials are sent to the API
    (over HTTPS, then encrypted at rest). Supports an optional key file.
  - Preview & select entries before importing; each becomes a **credential**
    (password type), and optionally an **asset (host)** for entries whose URL
    parses to a host (scheme → protocol/port: ssh/sftp/rdp/vnc/telnet/http(s)).
    Name clashes are auto-suffixed; the recycle bin is skipped.
  - verified: KDBX4 + Argon2d round-trip (build → decrypt → field extraction),
    wrong-password rejection.
- New frontend dependencies: `kdbxweb`, `hash-wasm`.

---

## [1.24.1] — 2026-06-28 — Drag-and-drop SFTP upload

### Added
- **Drag-and-drop upload** in the browser SFTP file browser (used by the
  **Files** page and each asset's SFTP view): drop one or more files onto the
  window to upload them into the current remote directory, with a drop-zone
  overlay and per-file progress. The Upload button now also accepts multiple
  files. Folders are skipped with a notice (the browser File API can't read
  directory contents).

---

## [1.24.0] — 2026-06-28 — Custom roles (admin-managed RBAC)

### Added
- **Create & manage custom roles.** Roles are no longer a fixed enum — admins
  can create roles and grant them any subset of the permission catalog from the
  **Roles & Permissions** page (built-in roles are locked).
  - migration `007_custom_roles`: `roles` table seeded with the 5 built-ins;
    `users.role` becomes an FK to `roles.key` (the old CHECK is dropped).
  - `RoleRepository` + `RoleService` install a **DB-backed permission resolver**
    at startup and reload it on any role change, so `can()`/`permissionsFor()`
    reflect live role definitions without re-login.
  - `GET /api/v1/roles` (roles + permission catalog, any auth user);
    `POST/PATCH/DELETE /api/v1/roles/:id` (require `users:manage`). Built-in
    roles can't be edited/deleted; a role in use can't be deleted; assigned
    permissions are validated against the catalog.
  - admin user create/update now validate the role against existing roles
    (DB FK is the backstop).
  - the user payload now includes the user's **effective permissions**; the
    client gates UI off that list (`useCan`/`hasPerm`) instead of a hardcoded
    matrix. Roles page is now an editor; the Users role dropdown is dynamic.
  - verified end-to-end against PostgreSQL 16: seeding, DB-backed resolver,
    custom-role CRUD, FK accept/reject, in-use delete guard, and down migration.

### Changed
- `Role` is now an open string (a role key) rather than a fixed union.

---

## [1.23.0] — 2026-06-28 — RBAC: dedicated permissions for tunnels & backup

### Added
- **Two new RBAC permissions**, so the recently-added features are
  individually grantable per role and appear in **Roles & Permissions**:
  - `tunnels:manage` — create & use SSH port-forwarding tunnels.
  - `backup:manage` — export & restore backups.
- Default grants: super-admin & admin get both; **user** gets both (parity
  with its existing session/resource access); read-only & auditor get neither.

### Changed
- Tunnels (REST + WebSocket) now require `tunnels:manage` instead of
  `sessions:connect`. Backup export/import now require `backup:manage`
  (export-with-secrets still also requires `credentials:reveal`; import no
  longer needs `resources:write`).
- The Tunnels and Backup sidebar items are hidden from roles lacking the new
  permissions (server still enforces). The Roles & Permissions matrix renders
  the two new capability rows automatically.

---

## [1.22.0] — 2026-06-28 — Backup & Restore

### Added
- **Backup & Restore screen.** Export your own hosts, credentials, folders and
  tags — with folder hierarchy, host→folder/credential links and tag
  assignments preserved — to a portable file, and restore them later.
  - `POST /api/v1/backup/export` — self-scoped; optional **"include credential
    secrets"**. When secrets are included the whole file is **encrypted with a
    user-chosen passphrase** (scrypt + AES-256-GCM) and `credentials:reveal` is
    required; otherwise it's metadata-only plaintext.
  - `POST /api/v1/backup/import` — requires `resources:write`. Decrypts if
    needed, then restores **additively** (never deletes/overwrites): on a name
    clash either **merge** (rename incoming `… (restored)`) or **skip** (link
    to the existing item). IDs are remapped so relationships survive; runs in a
    transaction with per-row SAVEPOINTs.
  - `BackupRepository` (owner-scoped export/import) + `backupCrypto`
    (passphrase KDF + authenticated encryption).
  - frontend **Backup & Restore** page (sidebar): export options + passphrase,
    file picker with encrypted-file detection, conflict mode, and a restore
    summary (added/skipped per type).
  - verified end-to-end against PostgreSQL 16: export with/without secrets,
    encryption round-trip + wrong-passphrase rejection, import preserving
    folder hierarchy/credential secrets/tags, merge-suffix, and skip.

---

## [1.21.2] — 2026-06-28 — Export users to a file

### Added
- **Export users (admin).** The Users page now has **CSV** and **JSON** export
  buttons that download the account list (username, email, full name, role,
  active/locked/MFA flags, last login, created-at, id). Client-side and
  non-destructive; no secrets are included. CSV is RFC-4180-quoted with a
  UTF-8 BOM so it opens cleanly in Excel.

---

## [1.21.1] — 2026-06-28 — Terminal username watermark

### Added
- **Username watermark** behind the browser SSH terminal — the logged-in
  user's name (and the host label) render as a faint, non-interactive
  watermark so it's obvious whose session a terminal belongs to. The xterm
  canvas is now transparent so the watermark shows through without obscuring
  output.

---

## [1.21.0] — 2026-06-28 — SSH port forwarding (Phase 5)

### Added
- **SSH tunnels — server-managed local forwarding (`ssh -L`).** The backend
  holds an SSH connection to a host and listens on a local TCP port; every
  inbound connection is forwarded through the host to a destination reachable
  from it (e.g. an internal database or web UI behind a bastion).
  - `TunnelManager` (in-memory, one `ssh2` client + `net.Server` per tunnel)
    with live stats (connections, active, bytes in/out) and graceful shutdown.
  - `GET/POST/DELETE /api/v1/tunnels` — self-scoped to the caller, gated by
    `sessions:connect`. Listener binds to **127.0.0.1 by default**; binding to
    all interfaces (`0.0.0.0`) is **admin-only**. Port range 1024–65535;
    per-user cap; duplicate-port and bind-error handling.
  - frontend **Tunnels** page (sidebar): create form (via-host, listen port,
    destination host/port, admin-only public toggle) + live table with
    status/traffic and stop, polled every few seconds.
  - verified end-to-end against a real in-process SSH server: forward
    round-trip, byte accounting, per-user isolation, duplicate-port rejection,
    and port release on stop.
- **Per-user WebSocket TCP tunnel** (`/api/v1/tunnel/connect`) — a
  JWT-authenticated browser-native relay of a raw TCP stream to a destination
  through an SSH host (same mechanism as the SSH/VNC gateways), so no
  unauthenticated listening port is ever exposed.

### Changed
- Extracted the host + credential resolution shared by the SSH gateway, tunnel
  manager, and WS tunnel into `ssh/resolveAuth.ts` (`resolveSshConnection`);
  the SSH gateway now uses it (behavior unchanged, all 23 tests pass).
- Refreshed the README roadmap table to match what has actually shipped.

---

## [1.20.1] — 2026-06-28 — Fix stale credential-storage warning

### Fixed
- **Credentials page banner** still claimed secrets were stored as *plaintext
  JSONB* and warned "don't store production secrets yet" — left over from
  before Phase 10. Secret material has in fact been **AES-256-GCM encrypted at
  rest** since 1.8.0 (`CredentialRepository` seals on write / opens on read;
  `CREDENTIAL_ENCRYPTION_KEY` is mandatory in production). Replaced the amber
  warning with an accurate "encrypted at rest" note, keeping the honest caveat
  that the data key is server-held and a KMS-backed master key / vault unlock
  is still planned.

---

## [1.20.0] — 2026-06-28 — Opt-in command history & branding favicon

### Added
- **Command history (opt-in, per user).** Browser SSH sessions can now record
  the commands you type, on a strictly **off-by-default** toggle in the
  terminal toolbar (commands may contain typed secrets, so recording is a
  deliberate choice).
  - migration `006_command_history` (per-user, append-only; rows survive host
    deletion via a `host_label` snapshot) + `CommandHistoryRepository`.
  - `GET/POST/DELETE /api/v1/command-history` — always self-scoped to the
    authenticated user (no cross-user reads/clears), gated by
    `sessions:connect`. List supports search + per-host filtering.
  - frontend: terminal toolbar toggle (persisted per browser, default off);
    keystrokes are folded into command lines client-side and POSTed on Enter
    when enabled. A slide-over **History panel** lists, searches, copies,
    re-inserts, and clears past commands, with a privacy warning.
  - verified end-to-end against PostgreSQL 16: migration up/down, schema
    (FKs, indexes), insert/list/clear.
- **Branding favicon.** The Branding admin screen can now set the browser-tab
  favicon alongside the app name and logo (stored server-side, applied at
  startup; `GET/PUT /api/v1/branding` carry `favicon`).

---

## [1.19.0] — 2026-06-28 — Theming, responsive UI & in-app branding

### Added
- **Light / dark mode.** Semantic colors are now CSS variables with dark
  (default) + light palettes; toggle (sun/moon) in the sidebar, persisted
  and defaulting to the OS preference.
- **Responsive layout** for phones/tablets: the sidebar becomes a
  hamburger drawer; two-column pages (Assets, Files) adapt; dense toolbars
  wrap.
- **In-app Branding screen** (admin): set the app **name** and **logo**
  from the UI — persisted server-side and shown to everyone (login
  included).
  - migration `005_app_settings` (key/value) + `AppSettingsRepository`
  - `GET /api/v1/branding` (public) / `PUT /api/v1/branding` (admin;
    validates logo is a data:image URI or http(s) URL, size-capped)
  - frontend branding store loads at startup with env-var fallbacks
    (`VITE_APP_NAME`, `VITE_APP_LOGO_URL`); Branding page under
    Administration with logo upload + preview.
  - verified end-to-end: set/read name+logo, anon PUT 401, bad logo 400.

---

## [1.18.0] — 2026-06-28 — VNC remote desktop (Phase 6)

### Added
- **Browser VNC** — open a host's remote desktop in the browser. A backend
  WebSocket↔TCP relay (`/api/v1/vnc/connect`, websockify-style) shuttles
  bytes between the browser's **noVNC** client and the target VNC server;
  the RFB protocol (incl. VNC auth) runs end-to-end. Gated by
  `sessions:connect`; records connection history (protocol `vnc`).
  - `backend/src/vnc/gateway.ts`
  - `desktop` adds `@novnc/novnc`; `VncPage` (`/hosts/:id/vnc`) renders the
    desktop, scales to fit, supports Ctrl+Alt+Del and fullscreen, and uses
    the host's stored credential password when revealable (else prompts).
  - Host detail shows **Open desktop** for `vnc` assets (SSH still shows
    Terminal + SFTP).
  - build target raised to es2022 (noVNC uses top-level await + BigInt).

### Notes
- VNC auth is end-to-end between noVNC and the server; for shared hosts
  where the connecting user can't reveal the owner's credential, they're
  prompted for the VNC password.

---

## [1.17.0] — 2026-06-28 — Files manager + Network tools

### Added
- **Files** (`/files`) — a unified file manager across all assets: pick an
  SSH/SFTP asset from a searchable list and browse/edit/upload/download its
  files inline (web build embeds the SFTP browser; desktop routes to the
  native one). `WebSftpPage` now accepts an optional `hostId` prop.
- **Network** (`/network`) — server-side diagnostics: **ping**,
  **traceroute**, **DNS lookup**, and **TCP port check**, gated by the
  `sessions:connect` permission.
  - `backend/src/routes/network.ts` runs external tools via `spawn` with an
    argument array (no shell) and validates the target to a hostname/IP
    charset — command injection is not possible (verified: `a;rm -rf /`
    → 400). Time- and output-bounded.
  - DNS falls back to the system resolver so `/etc/hosts` names resolve.
  - Dockerfile installs `iputils` + `traceroute` so ping/traceroute work
    in the container.
- Both move out of the sidebar's "Coming soon" into the active Workspace
  section (which is now empty and removed).

---

## [1.16.0] — 2026-06-28 — Audit log viewer

### Added
- **Audit log page** (`/audit`) — a read-only, filterable view of recorded
  security and resource events (login success/failure, MFA, user/host/
  credential create/update/delete, token reuse, etc.) with timestamp,
  user, action, resource, IP, and outcome; paginated.
  - backend: `GET /api/v1/audit` gated by the `audit:read` permission
    (admin / auditor), `AuditRepository.list` with action/outcome/user
    filters + a users join for usernames.
  - widened the audited-action allow-list so host/folder/tag mutations are
    recorded with their real action (were collapsing to `config_change`).
  - sidebar: **Audit** moves out of "Coming soon" into Administration,
    visible to anyone with `audit:read` (so auditors see it too).
  - verified end-to-end: admin reads & filters the log, a read-only user
    is 403, and failed logins are recorded as `login_failed`.

---

## [1.15.0] — 2026-06-28 — Per-user host sharing

### Added
- **Share an asset with specific users** (in addition to share-with-all).
  A host can now be shared with a chosen set of users; they can see and
  connect to it (via the owner's credential) but not edit it. Others still
  can't see it at all.
  - migration `004_host_shares` (host_id × user_id join table)
  - host visibility is now `owner OR shared-with-all OR shared-with-you`;
    `getById`/`touch` honor it; `update`/`delete` stay owner-only
  - owner-managed endpoints `GET`/`PUT /api/v1/hosts/:id/shares`
  - `GET /api/v1/users/directory` — minimal user list for the share picker
    (any authenticated user)
  - host form: "Share with specific users" checklist alongside the
    share-with-all toggle; selections load on edit and save on submit
  - verified end-to-end: shared with one user → that user sees & connects,
    a third user is fully 404'd, neither non-owner can edit.

---

## [1.14.0] — 2026-06-27 — Shared hosts (Assets) + screen rename

### Added
- **Host sharing — define once, use everywhere.** A host can be marked
  *shared*; shared hosts are visible and connectable by every user on the
  instance, with **no duplication**. Connecting users authenticate with
  the owner's linked credential (resolved server-side — the secret is
  never exposed to them). Shared hosts remain **editable/deletable only by
  their owner**.
  - migration `003_shared_hosts` (adds `hosts.is_shared` + partial index)
  - host visibility query is now `owner OR shared`; `getById`/`touch`
    honor shared; `update`/`delete` stay owner-scoped
  - SSH & SFTP gateways resolve credentials via the host owner
  - `is_shared` on create/update; `is_shared` + `owner_id` in responses
  - a "Share with all users" toggle in the host form; "Shared" /
    "Shared with you" badges; non-owners can connect but don't see
    edit/delete on shared hosts
  - verified end-to-end: a second user sees a shared host, connects via
    SFTP using the owner's credential, and is 404'd on edit/delete.
- **"Hosts" screen renamed to "Assets"** in the sidebar and page copy
  (routes unchanged).

---

## [1.13.0] — 2026-06-27 — Roles & Permissions (RBAC)

### Added
- **Role-based access control, enforced server-side.** A capability
  matrix maps each role to permissions; the baseline for every
  authenticated user is *view-only*, with extra capabilities granted per
  role:
  - `super_admin` / `admin`: everything (incl. user management)
  - `user`: create/edit/delete own resources, open SSH/SFTP, reveal secrets
  - `readonly`: browse only — no writes, no sessions, no secret reveal
  - `auditor`: read-only + audit logs
  - `backend/src/domain/permissions.ts` (+ tests) and middleware
    `requirePermission` / `requireWrite`.
  - Enforced on hosts/credentials/folders/tags mutations (`resources:write`),
    SSH & SFTP gateways (`sessions:connect`), and credential reveal
    (`credentials:reveal`). Verified end-to-end: a read-only user can list
    hosts (200) but is blocked from create/connect (403); a normal user can.
- **Roles & Permissions page** (`/roles`, admin-only) showing the full
  matrix and the current user's effective permissions.
- **UI gating** via a mirrored `shared/lib/permissions.ts` + `useCan`
  hook: New/Edit/Delete, Connect/SFTP, Favorite, and Reveal-secret
  affordances are hidden for roles that lack the permission (Hosts, Host
  detail, Credentials, Folders, Tags). The server remains the source of
  truth.

---

## [1.12.0] — 2026-06-27 — User management UI (add non-admin users)

### Added
- **Users admin page.** Admins (and super-admins) can now list, create,
  re-role, enable/disable, and delete users from the UI — including
  **non-admin** accounts (user / read-only / auditor / admin /
  super-admin). The backend `/api/v1/admin/users` endpoints already
  existed; this adds the missing front-end.
  - `modules/users/UsersPage.tsx` + `usersAdminApi.ts`
  - role-gated **Administration → Users** sidebar entry and `/users`
    route (visible only to admin / super_admin; the backend enforces the
    same with `requireRole`)
  - guards against changing or deleting your own account from the list
- Verified end-to-end: create a `user`-role account, it logs in with the
  right role, is correctly 403-forbidden from admin endpoints, and shows
  up in the admin listing.

---

## [1.11.0] — 2026-06-27 — Browser SFTP file browser

### Added
- **Browser-based SFTP.** A session-based REST gateway on the backend
  (`/api/v1/sftp/*`) holds the SSH+SFTP connection (via `ssh2`) and the
  web UI issues authenticated HTTP calls against a `session_id`, so the
  browser build can browse files without the native desktop app.
  - `backend/src/ssh/sftpGateway.ts` — connect, list, read, write, mkdir,
    rename, delete, download (streamed), upload (base64), disconnect.
    Sessions are bound to the owning user and reaped after 10 min idle.
    Supports password and private-key auth.
  - `WebSftpPage.tsx` + `webSftpApi.ts` — file browser with navigate,
    view/edit text (≤1 MB), download, upload, mkdir, rename, delete, and
    a password-prompt fallback when no credential is stored.
  - The `/hosts/:id/sftp` route renders the web browser in a browser and
    the native page in the desktop app.
  - Verified end-to-end against a real SFTP server (connect → list → read
    → mkdir → write → download → upload → rename → delete → disconnect).

### Known limitations
- chmod/chown and recursive folder download remain desktop-only.
- Inline view/edit is capped at 1 MB; larger files download instead.

---

## [1.10.0] — 2026-06-27 — Self-service password change (Phase 2.x)

### Added
- **Self-service password change.** `POST /api/v1/auth/change-password`
  (authenticated) re-verifies the current password, enforces the password
  policy (≥12 chars, mixed character classes), rejects reusing the current
  password, stores the new Argon2 hash, and **revokes all refresh
  sessions** so other devices must sign in again.
  - `usecases/changePassword.ts` + `userRepo.updatePasswordHash` + unit
    tests (correct change, wrong current → 401, weak → 422, unchanged →
    409). Verified end-to-end (old password rejected, new accepted).
  - The desktop/web **Change password** page is now a working form
    (was a "coming in Phase 2" placeholder); on success it signs out and
    redirects to login.

---

## [1.9.0] — 2026-06-27 — Browser SSH (web terminals via gateway)

### Added
- **Browser-based SSH terminals.** A new WebSocket gateway on the
  backend (`/api/v1/ssh/connect`) holds the real SSH connection (via
  `ssh2`) and streams it to an xterm.js terminal in the browser, so the
  web build can open live shells without the native desktop app.
  - `backend/src/ssh/gateway.ts` — token-authenticated WS endpoint that
    resolves the host + (decrypted) credential, opens an SSH shell, and
    bridges bytes both ways; records connection history; supports
    password and private-key auth and live window resize.
  - `desktop/src/modules/sessions/components/WebTerminalPane.tsx` —
    xterm.js terminal wired to the gateway, with a password prompt
    fallback when the host has no stored credential.
  - `TerminalWorkspace` renders the web pane in the browser and the
    native pane in the desktop app.
  - nginx config proxies WebSocket upgrades and uses a long read timeout
    so idle sessions aren't dropped.
- Verified end-to-end against a real `sshd`: connect → run a command →
  receive output over the socket.

### Security notes
- The gateway accepts the target host key on first sight (TOFU is not yet
  persisted server-side); the fingerprint is logged. A server-side
  known-hosts store is a follow-up.
- The access token is passed as a WebSocket query parameter (browsers
  can't set headers on a WS); it travels over TLS. Access logging for the
  gateway path should be kept off to avoid token capture.

### Known limitations
- Browser **SFTP** is not yet implemented — the SFTP browser still
  requires the native desktop app.

---

## [1.8.0] — 2026-06-26 — Phase 10: encrypted credential secrets at rest

### Fixed (deployability)
- **Reconstructed the missing SQL migrations.** `backend/migrations/`
  was absent from the repository, so `migrate.js up` created no tables
  and the Docker image build (`COPY migrations`) failed outright. Added
  `001_auth` (users, mfa_devices, refresh_sessions, audit_logs) and
  `002_sessions` (folders, tags, credentials, hosts, host_tags,
  connection_history), derived from the repository column contracts and
  verified end-to-end against PostgreSQL 16 (apply, rollback,
  idempotent re-run, login, and credential round-trip).
- **Aligned production deploy env vars with the code.** The
  `deploy/` files used variable names the backend never reads, which
  meant the documented production deploy could not start:
  `JWT_SECRET` → `JWT_ACCESS_SECRET`, `CORS_ORIGINS` →
  `CORS_ALLOWED_ORIGINS`, `NODE_ENV`-only → also set `APP_ENV`,
  `PORT` → `AUTH_HTTP_PORT`, `RATE_LIMIT_MAX/WINDOW` →
  `RATE_LIMIT_{LOGIN,API}_PER_MIN`. Updated
  `docker-compose.production.yml`, `.env.production.example`,
  `generate-secrets.sh`, `install.sh`, and `deploy/README.md`.
- Fixed invalid YAML in `docker-compose.production.yml` (a `:?...`
  default-error hint contained a colon, breaking the parser).

### Added
- **Credential secrets are now encrypted at rest** with AES-256-GCM.
  The `secret_data` payload is sealed in an authenticated-encryption
  envelope (`{__enc__, iv, tag, ct}`) before it touches PostgreSQL and
  is decrypted transparently on read. Routes and the desktop are
  unchanged — they still send and receive a plain `secretData` object.
  Implemented with Node's built-in `crypto`; no new dependency.
- **`CREDENTIAL_ENCRYPTION_KEY`** config (32 bytes, base64 or hex).
  Required in production. In development it is optional: when unset the
  key is derived deterministically from `JWT_REFRESH_SECRET` via
  HKDF-SHA256 (with a startup warning) so existing dev setups keep
  working and encrypted rows survive restarts.
- `backend/src/crypto/secretBox.ts` — `createSecretBox`,
  `resolveSecretKey`, `isSecretEnvelope`, plus a 14-case unit suite
  (`secretBox.test.ts`) covering round-trip, nonce freshness, GCM
  tamper rejection, wrong-key rejection, and key resolution.
- `npm test` script for the backend (Node's built-in test runner via
  `tsx`).

### Changed
- `CredentialRepository` takes a `SecretBox` and seals secrets on
  create/update, opens them on read.
- Empty secret objects (`{}`) are stored as-is rather than encrypting
  an empty payload — keeps "no secret" rows trivially readable.

### Compatibility
- **Backward compatible.** Pre-Phase-10 plaintext JSONB rows are
  detected (no `__enc__` marker) and passed through unchanged on read,
  then re-encrypted the next time they are saved. No migration or
  backfill is required.

### Risks / notes
- The dev-mode derived key is tied to `JWT_REFRESH_SECRET`; rotating
  that secret without first setting a dedicated
  `CREDENTIAL_ENCRYPTION_KEY` would make previously-encrypted secrets
  unreadable. Production refuses to start without an explicit key.
- Key rotation tooling and a KMS-backed master key are deferred to a
  later Phase 10.x slice.

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
