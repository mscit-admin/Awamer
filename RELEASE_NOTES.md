# Release Notes — NetSphere Terminal

This document records **every issue** found during each release-candidate
process and the fix applied. Entries are append-only.

---

## 1.6.0.1 — 2026-05-26 — Production deployment package

This is the **production-ready release** for self-hosting NetSphere on
your own Ubuntu server. It bundles two things:

1. The latest source (1.6.0) with two recurring fixes baked into the
   baseline so they never come back
2. A complete `deploy/` directory with everything needed to ship the
   backend on an Ubuntu host with TLS, nginx, automated backups, and
   systemd integration

### What ships in `deploy/`

| File | Purpose |
|---|---|
| `docker-compose.production.yml` | Production compose — strict-secrets, named volumes, internal network only |
| `.env.production.example` | Template for all required environment variables |
| `nginx/netsphere.conf` | Reverse-proxy config with HSTS + security headers |
| `scripts/install.sh` | One-shot interactive installer for Ubuntu |
| `scripts/generate-secrets.sh` | Cryptographically strong secret generation |
| `scripts/backup.sh` | Postgres dump + auto-rotate (keeps last 14 daily) |
| `scripts/restore.sh` | Destructive restore from a backup file |
| `systemd/netsphere.service` | Auto-start on boot |
| `README.md` | Complete deployment guide with troubleshooting |

### Quick start

On a fresh Ubuntu 22.04+ server with a domain pointing at it:

```bash
sudo mkdir -p /opt/netsphere && sudo chown $USER /opt/netsphere
cd /opt/netsphere
tar xzf ~/netsphere-1.6.0.1.tar.gz --strip-components=1
chmod +x deploy/scripts/install.sh
./deploy/scripts/install.sh
```

The installer:
1. Installs Docker + nginx + certbot
2. Generates and validates production secrets
3. Builds the auth-service image
4. Starts the stack (Postgres + Redis + auth-service)
5. Waits for health check to pass
6. Configures nginx with your domain
7. Issues a Let's Encrypt TLS certificate
8. Prints a summary with bootstrap admin credentials

Total time: ~3-5 minutes on a 1 GB VPS.

### What it does NOT include

- **Desktop client distribution.** The Tauri desktop app must be built
  on each platform (Linux/macOS/Windows) and distributed to users as
  `.deb` / `.AppImage` / `.dmg` / `.msi` files. See `deploy/README.md`
  → "Desktop distribution" for three options.
- **High availability.** Single-host deployment. No replicated Postgres,
  no load balancing. Sufficient for small teams (< 50 users).
- **Email integration.** No SMTP setup — password resets, audit log
  notifications, etc. are not yet supported.

### Two recurring code fixes baked in permanently

These were patched in-place in earlier versions but kept regressing
because the baseline source still had the original bug:

1. `Vec::with_capacity(entries_raw.len())` → `Vec::new()` in
   `commands/sftp.rs`. The russh-sftp `ReadDir` is a lazy iterator
   without `.len()`.
2. `let mut channel = handle.channel_open_session()` → `let channel`
   in `commands/ssh.rs`. The variable is never reassigned, so the
   `mut` triggered a useless warning on every build.

### Known issue not blocking deployment

The desktop client's SFTP page may throw "Cannot read properties of
undefined (reading 'invoke')" on some Tauri 2.x configurations,
caused by `@tauri-apps/plugin-dialog` looking for an old API path.
**This affects only the desktop client**, not the server. We're
working on a workaround for 1.6.1 (switching to direct
`window.__TAURI_INTERNALS__.invoke` calls for the dialog APIs).

The server, terminal, key auth, multi-tab, and SFTP API are all
working correctly. Only the file picker dialog in the SFTP UI is
affected.

### Security defaults

- All ports except 22, 80, 443 firewalled by the installer's guidance
- Postgres + Redis on private Docker network, no host ports
- Backend bound to `127.0.0.1:8081`, nginx is the public face
- HSTS, X-Frame-Options DENY, no-referrer policy
- Compose refuses to start if any secret is missing or placeholder
- `.env.production` permissions enforced to 600

### Server requirements

- Ubuntu 22.04 LTS or 24.04 LTS (Debian 12 works too)
- ≥ 1 GB RAM, ≥ 10 GB disk
- A user with sudo (not root)
- Domain name with A record pointing to the server
- Open ports: 22, 80, 443

---

## 1.6.0 — 2026-05-12 — Phase 4b: SFTP write operations

**Codename:** Two-Way

### Scope summary

The other half of the SFTP feature. 1.5.0 was read-only; 1.6.0 adds
everything you need to actually manage remote files:

| Capability | Status |
|---|---|
| Upload from system file picker | ✅ |
| Drag-and-drop upload from desktop | ✅ |
| Inline rename (click rename icon → type → Enter) | ✅ |
| Delete file (with confirmation) | ✅ |
| Delete folder (recursive, with strong confirmation) | ✅ |
| New folder | ✅ |
| In-place text editor for files < 1 MB | ✅ |
| Refresh button (re-list current directory) | ✅ |
| Right-click context menu on any entry | ✅ |
| chmod / chown / permissions UI | ❌ deferred to 1.7.0 |
| Recursive folder download | ❌ deferred to 1.7.0 |
| Cross-host copy/move | ❌ deferred to 1.7.0 |

Together with 1.5.0, NetSphere is now a complete SFTP client.

### Added (Rust / Tauri side)

Seven new IPC commands in `commands/sftp.rs`:

| Command | Notes |
|---|---|
| `sftp_rename(session_id, from, to)` | Atomic where the server supports it |
| `sftp_remove_file(session_id, path)` | Single file delete |
| `sftp_remove_dir(session_id, path, recursive)` | Returns count of items removed |
| `sftp_mkdir(session_id, path)` | Creates a directory |
| `sftp_read_text(session_id, path, max_bytes)` | Loads a UTF-8 file into memory; refuses files larger than `max_bytes` |
| `sftp_write_text(session_id, path, content)` | Truncates and writes — used for the inline editor |
| `sftp_upload(app, session_id, local_path, remote_path)` | Streams in 64 KiB chunks, emits same progress events as `sftp_download` |

Recursive delete is implemented as a boxed async fn — Rust requires the
recursion-through-async pattern with `Pin<Box<dyn Future>>` for async
functions that call themselves.

### Added (desktop side)

- **Toolbar** on the breadcrumb row: Refresh, New folder, Upload
- **Drag-and-drop zone** — drop files from your desktop onto the file
  listing area; a "Drop to upload" overlay appears while dragging
- **Per-row action buttons** (visible on row hover):
  - Edit (pencil icon, files only, only when ≤ 1 MB)
  - Download
  - Rename (inline editable text field)
  - Delete (red on hover)
- **Right-click context menu** with the same actions
- **Text editor modal** — opens when you click Edit on a small text file:
  - Native textarea (deliberately simple — Monaco editor was considered
    but is ~7 MB of JS, which would balloon the app significantly)
  - "Modified" badge appears as soon as you type
  - Save button is disabled until you've actually made changes
  - Close with unsaved changes asks for confirmation
- **Upload progress** uses the same tray as downloads — both kinds of
  transfers shown together with direction-specific icons

### Architecture decisions

**Why not Monaco editor.** Monaco (the editor that powers VS Code) is
fantastic but adds ~7 MB of JavaScript and a complex build setup. A plain
textarea is 100 lines vs that, supports word wrap, copy/paste, undo via
the OS, and is good enough for the typical use case (editing
`/etc/nginx/sites-enabled/foo` or a `.env` file). Syntax highlighting
can come in 1.7.0 with a much lighter library (Shiki or PrismJS) if
users ask for it.

**Why drag-drop uses two listeners.** Tauri webviews don't reliably fire
HTML5 `drop` events with `dataTransfer.files` on every platform.
Linux/WebKitGTK in particular has historically been spotty here. We
also subscribe to Tauri's native `tauri://drag-drop` event channel as
a fallback. Whichever fires first wins.

**Why 1 MB editor limit.** Files larger than 1 MB are usually logs or
data dumps that need streaming/grepping, not editing. Loading them
fully into a textarea would freeze the renderer. Users who really want
to edit a large file should download → edit locally → upload back.

**Why no Monaco / no syntax highlighting in 1.6.0.** We deliberately
ship a fast, lightweight editor first. Adding syntax highlighting later
is purely additive and easy. Shipping Monaco first then ripping it out
would be churn.

### Known limitations / deferred to 1.7.0+

- No chmod / chown — permissions and ownership are display-only
- No recursive folder download (forces individual file downloads)
- No "copy from host A to host B" — every transfer goes through your
  local machine
- No syntax highlighting in the text editor
- No file search across the remote tree
- No remote symlink resolution (we treat symlinks as opaque)

### How to upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.6.0.tar.gz --strip-components=1 --no-same-owner
make docker-up
sleep 10

cd desktop
npm install
npm run tauri dev          # incremental, ~1-2 min (no new heavy crates)
```

No backend changes — no migrations, no API surface changes.

### Test plan

In priority order. Tests 1-4 are the most important.

| # | Test | Steps |
|---|---|---|
| 1 | **Upload via button** | Open SFTP → click Upload → pick a file → progress bar shows → file appears in listing |
| 2 | **Drag-and-drop upload** | Drag a file from your desktop file manager onto the SFTP listing area → overlay appears → drop → upload proceeds |
| 3 | **New folder** | Click New folder → enter name "test123" → folder appears |
| 4 | **Rename a file** | Hover a file → click pencil icon → type new name → Enter → file shows new name |
| 5 | **Delete a file** | Hover a file → click trash icon → confirm → file disappears |
| 6 | **Delete folder (recursive)** | Create folder, upload file into it, delete folder → both go |
| 7 | **Edit a text file** | Click pencil on a small text file → editor opens → type changes → Save → close → reopen → changes persisted |
| 8 | **Refuses big file edit** | Try to Edit on a multi-MB file → error toast "File is X bytes; only files under 1 MB can be edited in-place" |
| 9 | **Right-click context menu** | Right-click any file → menu appears with Edit/Download/Rename/Delete |
| 10 | **Refresh** | Make a change on the server via another terminal → click Refresh → new state appears |

### Risks

- `russh-sftp` write methods (`create`, `remove_file`, `remove_dir`,
  `rename`, `create_dir`) not compile-tested in my sandbox. If method
  names differ, cargo will tell you precisely; one-line patches per
  method.
- `f.write_all` on the returned remote-file object assumes
  `tokio::io::AsyncWriteExt` semantics — `russh-sftp` 2.x should
  comply but I haven't verified.
- Tauri's `tauri://drag-drop` event channel name may have changed in
  Tauri 2.x; if drag-drop silently doesn't trigger, that's the most
  likely culprit.

---

## 1.5.0 — 2026-05-12 — Phase 4a: SFTP file browser (browse + download)

**Codename:** Carry

### Scope summary

The first slice of Phase 4 — a visual SFTP file browser that opens
alongside the SSH terminal. **Read-only** in 1.5.0:

| Capability | Status |
|---|---|
| Browse remote file tree | ✅ |
| Navigate by clicking directories | ✅ |
| Path breadcrumb (jump to any parent) | ✅ |
| Single-file download with progress | ✅ |
| Sort: directories first, then alphabetic | ✅ |
| Multi-file download | ❌ deferred to 1.6.0 |
| Upload | ❌ deferred to 1.6.0 |
| Rename / delete / mkdir | ❌ deferred to 1.6.0 |
| In-place text edit | ❌ deferred to 1.6.0 |
| Drag-drop | ❌ deferred to 1.6.0 |
| chmod / chown | ❌ deferred to 1.7.0 |

The deliberate scope cut is so 1.5.0 ships fast and we validate the
SFTP plumbing (russh-sftp protocol channel, session management, progress
streaming) before adding the more error-prone write paths.

### Added (Rust / Tauri side)

- New crate dependencies:
  - `russh-sftp = "2.0"` (SFTP protocol on top of russh channels)
  - `tauri-plugin-dialog = "2.0"` (system save dialog for picking download
    destinations)
- New module `desktop/src-tauri/src/commands/sftp.rs` (~400 lines):
  - Independent session registry from `ssh.rs` (terminal sessions and
    SFTP sessions are separate even when they target the same host)
  - Re-uses `ssh.rs`'s host fetch and credential resolution helpers
    (made `pub(crate)` for cross-module access)
  - Re-uses 1.3.0's `known_hosts` module for TOFU verification —
    SFTP and terminal share the same trust store
- 5 new IPC commands:
  - `sftp_connect(args)` → opens SSH + SFTP subsystem, returns
    `session_id` and `initial_path` (the canonicalised remote `.`,
    usually `$HOME`)
  - `sftp_list(session_id, path)` → returns sorted `Vec<RemoteEntry>`
    with name, kind, size, mtime, mode bits
  - `sftp_download(session_id, remote_path, local_path)` → streams
    file in 64 KiB chunks, emitting `sftp:progress:{sid}` events
  - `sftp_disconnect(session_id)` → drops session, closes connection
  - `sftp_list_sessions()` → diagnostic; lists active SFTP sessions

### Added (desktop side)

- `desktop/src/modules/sessions/components/SftpPage.tsx` (~430 lines):
  - Header with host info + Disconnect button
  - Breadcrumb path navigation (click any parent segment)
  - File table: name + size + mtime + POSIX mode + per-row download icon
  - Click directory → navigate into it
  - Click file → opens system save dialog, then streams download
  - Live downloads tray at the bottom of the page with per-file
    progress bars and final size confirmation
- New route: `/hosts/:id/sftp`
- HostDetailPage's "Connect" card now has an additional **SFTP** button
  (next to Connect) for SSH hosts

### Architecture decisions

**Why SFTP gets its own session registry, not the existing SshSession.**
SFTP and the interactive shell run on **separate channels** of the same
SSH connection. They have completely different lifetimes, UIs, and
mental models. Sharing state would couple two features that should
evolve independently. The plumbing cost is small: each session is its
own `russh::client::Handle` + `SftpSession`. If both terminal and SFTP
are open on the same host, you pay for two SSH handshakes, which is
acceptable for desktop use.

**Why we re-use the `known_hosts` store, not duplicate it.** A user's
trust decisions ("yes, this server's host key is legitimate") should be
shared across protocols. If you've trusted a server's key for the
terminal, the SFTP browser should silently accept the same key. The
store is a process-wide singleton via `OnceCell`, so both modules see
the same data.

**Why downloads use a system dialog, not in-app file picker.** Users
have strong intuitions about where files go on disk. The OS dialog
respects their conventions (Downloads folder, "Recents", network
volumes) and works correctly with sandboxing, permissions, and external
drives. Building an in-app picker would replace something well-tested
with something we'd have to maintain.

### Risks I want to be upfront about

- **Russh-sftp `2.0` API is new to me.** The crate I'm using has had
  multiple major-version revisions. If the actual installed version
  exposes different method names — e.g. `read_dir` vs `readdir`,
  `permissions` vs `mode`, `mtime` vs `modified_time` — the build
  will fail with localised errors. Send me the first ~30 lines of
  cargo output and I'll patch 1.5.0.1 fast.
- **The dialog plugin requires the correct permissions** to appear in
  `capabilities/default.json`. I added `dialog:default`, `dialog:allow-save`,
  `dialog:allow-open`. If Tauri 2.x has renamed any of these, the
  app will refuse to open the save dialog at click time. Fix is one
  line in the capabilities JSON.
- **Auth path duplication.** I copied the `ResolvedAuth` logic from
  `ssh.rs` into `sftp.rs` for now rather than refactoring. The
  duplication is documented; a 1.5.x patch should extract a shared
  helper to `commands/auth.rs`.

### How to upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.5.0.tar.gz --strip-components=1 --no-same-owner
make docker-up
sleep 10

cd desktop
npm install                # adds tauri-plugin-dialog
npm run tauri dev          # first build adds russh-sftp deps (~3-5 min)
```

No backend changes in 1.5.0 — no migrations, no API changes.

### Test plan

| # | Test | Expected |
|---|---|---|
| 1 | Click **SFTP** on a host's detail page | Opens the SFTP browser, lists `$HOME` |
| 2 | Click a subdirectory | Browser navigates into it, list refreshes |
| 3 | Click the home icon | Returns to `/` (root) |
| 4 | Click a path segment in the breadcrumb | Navigates to that parent |
| 5 | Click a file | OS save dialog appears |
| 6 | Confirm save location | Downloads tray shows progress bar, completes with ✓ |
| 7 | Click Disconnect | Returns to host detail page; session closed on Rust side |
| 8 | Open SFTP for a host without `credential_id` | Should prompt for SSH password (same flow as terminal) |
| 9 | Open SFTP for a host using ssh-agent | Should connect without any prompt |

---

## 1.4.0 — 2026-05-11 — Phase 3 Polish

**Codename:** Continuity

### Scope summary

Four quality-of-life additions that wrap up Phase 3 and make NetSphere
suitable for daily use as a real SSH workstation:

1. **Tab persistence** — your tab list survives app restarts
2. **Reconnect button** on disconnected tabs (manual; full auto-reconnect
   deferred — see "Decisions" below)
3. **SSH agent integration** — use system-loaded keys without copy/paste
4. **Permanent icon fix** — the convert step is no longer needed after extracts

### Added

**Desktop side:**
- `terminalTabsStore` now wraps `zustand/persist` with localStorage.
  Tabs survive app restarts. Runtime fields (`sessionId`, `phase`,
  `errorMessage`, `hostKeyDetails`) are reset on rehydrate so restored
  tabs land as `disconnected` — the SSH session is gone, only the
  tab's identity persists.
- `TerminalPane` shows a centred Reconnect overlay when a restored tab
  has no live xterm. A header Reconnect button appears on any
  disconnected tab.
- `TerminalPane` recognises credentials of type `agent` and skips the
  password/passphrase prompt entirely.

**Rust / Tauri side:**
- `AuthMethod::SshAgent` variant added. When the user's credential is
  type `agent`, the Rust side opens a Unix-socket connection to
  `$SSH_AUTH_SOCK`, lists all loaded identities, and tries them
  one-by-one. The first identity the server accepts is used.
- New error codes the renderer can switch on:
  - `ssh_agent_unavailable` — `$SSH_AUTH_SOCK` not set
  - `ssh_agent_connect_failed` — couldn't reach the agent socket
  - `ssh_agent_query_failed` — agent refused to list identities
  - `ssh_agent_no_identities` — agent has no keys loaded
  - `ssh_agent_auth_failed` — generic agent-side error

**Packaging:**
- The tarball now ships **real 8-bit RGBA PNG icons** at all required
  sizes (32, 128, 256, 512). The `convert PNG32:` workaround is no
  longer needed after extract.

### Changed

- `TerminalPane`'s auto-connect-on-mount logic now early-returns when
  the tab is rehydrated as `disconnected`. Without this, opening the
  app would fire a wall of connection attempts (and password prompts)
  for every restored tab — which is hostile.

### Decisions worth flagging

**Why no automatic reconnect on network drop.** I considered building a
retry-with-backoff path that re-establishes a dropped SSH session
silently. After thinking about it, I decided against it:

1. Re-establishing SSH from scratch **loses the shell state** — working
   directory, environment variables, any running `screen`/`tmux`
   session. That's confusing UX: it looks like the session survived
   but actually it's a fresh shell.
2. The proper solution to "survive network drops" is `mosh`, not
   SSH-with-retry. SSH was never designed to survive network drops.
3. The manual Reconnect button I added is one click. Users who want
   resilience can wrap their work in `tmux`/`screen`, which preserves
   state across reconnects.

If you DO want automatic retry in a future release (1.5.0 or later),
tell me — but I think the value-to-confusion ratio is poor.

**Why ssh-agent is a "credential" instead of a host-level toggle.**
Two reasons: (a) you might use different agents (e.g., normal
ssh-agent vs gpg-agent for hardware keys) — making it a credential
lets you label and pick one; (b) it reuses all the existing host →
credential plumbing, no schema changes needed.

### Known limitations

- ssh-agent on **Windows** is untested. The russh agent client uses
  Unix sockets (`SSH_AUTH_SOCK`); Windows has named pipes instead.
  If you're on Linux/macOS, this works.
- Tab persistence is `localStorage`-scoped to the dev URL
  (`http://localhost:1420`). If you build a release binary at a
  different origin, the stored list won't carry over — minor edge case.
- No tab-bar drag-to-reorder. (Maintain order by creation date for now.)

### Upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.4.0.tar.gz --strip-components=1 --no-same-owner

# 🎉 NO MORE ICON CONVERT STEP — the tarball ships valid RGBA PNGs.

make docker-up
sleep 10

cd desktop
npm install
npm run tauri dev    # incremental, ~1-2 min (only the changed Rust + new zustand persist)
```

No backend changes in 1.4.0 — no migrations, no API changes.

### Tests to run

| # | Test | Method |
|---|---|---|
| 1 | Icons no longer need conversion | After extracting, immediately run `npm run tauri dev` without touching icons — should compile clean |
| 2 | Tabs persist across restart | Open 2 SSH tabs → close the app (X button) → reopen `npm run tauri dev` → sidebar → Terminal — both tabs should be there, both marked as disconnected, with Reconnect buttons |
| 3 | Reconnect button works | Click Reconnect on a restored tab → password/key flow runs as normal → reach shell |
| 4 | ssh-agent works | `ssh-add ~/.ssh/id_ed25519` from terminal → Create credential type **SSH Agent** in NetSphere → attach to host → Connect → reach shell with no prompts |
| 5 | ssh-agent error path | Same as 4 but with no keys loaded (`ssh-add -D` to clear) → should see `ssh_agent_no_identities` error |

### Risks

- Tab persistence relies on `zustand/persist` middleware which is part
  of the zustand package — no new dependency. TypeScript clean.
- ssh-agent code path uses russh's agent client. I couldn't compile-test
  in the sandbox; if `russh_keys::agent::client::AgentClient` has API
  drift, the build will fail with a localized error. The signature for
  `authenticate_future` may also differ. If you hit:
  - `no method named connect_uds` — likely renamed to `connect`
  - `authenticate_future` mismatch — agent auth API might be
    `authenticate_future_request` or similar
  
  Send me the cargo output and I'll patch 1.4.0.1 fast.

---

## 1.3.1 — 2026-05-11 — Disable MFA in-app

### Added

- **Backend:** `POST /api/v1/auth/mfa/disable` endpoint. Body
  `{ password: string }`. On success returns 204; on wrong password
  returns 401 with `{ error: { code: "invalid_credentials", ... } }`.
  Audit-logged with action `mfa_disable` (success or failure).
- **Backend use case:** `MFAUseCase.disable(userId, password)` —
  verifies password via argon2, deletes all MFA devices for the user,
  clears `mfa_enabled` on the user record.
- **Desktop API:** `authApi.mfaDisable(password)`.
- **Desktop store:** new `refreshUser()` action on the auth store so
  the local `user.mfa_enabled` flag updates after disable without
  needing a logout/login cycle.
- **Desktop UI:** the existing "Two-factor authentication" settings
  page now detects when MFA is already enabled and shows a disable
  flow instead of the enrollment intro. The disable flow requires
  the user to type their current password before the action is
  accepted. After success, navigates back to /settings with a banner
  confirming "MFA disabled".

### Security rationale

The disable action requires the **current password** as a
re-authentication step. The reasoning: a stolen access token (e.g.
from XSS in a related app, malware on the user's machine, or a
shared device left logged in) shouldn't be enough to remove the
account's second factor. Requiring the password forces an attacker
to have both the token AND the password — the same level of
protection MFA was added to provide in the first place. This mirrors
how GitHub, Google, and AWS handle MFA disable.

### Why this is a 1.3.1 and not a 1.4.0

This is a small gap-fix, not a feature. The disable path existed only
via SQL until now, which was a deliberate scope cut in Phase 1 — and
a wrong one in retrospect. Promoting it to a proper UI flow doesn't
warrant a minor version bump.

### Upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.3.1.tar.gz --strip-components=1 --no-same-owner

# After extracting, fix the icons (recurring) and rebuild backend
cd desktop/src-tauri/icons
for f in *.png; do convert "$f" PNG32:"$f" 2>/dev/null; done
# OR if the icons are valid already, skip the above

cd ~/netsphere
make docker-up
sleep 10

cd desktop
npm install                # adds nothing new but refreshes lockfile
npm run tauri dev          # incremental, ~1 min
```

No DB migrations.

### Test

1. Sign in (MFA still required since it's currently enabled).
2. Click your avatar → Settings → Two-factor authentication.
3. **New:** instead of the enrollment intro, you see a disable
   confirmation card.
4. Type your password → click "Disable two-factor authentication".
5. You should land back at Settings with "MFA disabled" briefly.
6. Sign out → sign in again → you should NOT be prompted for a
   6-digit code.
7. (Optional re-enable test) Settings → Two-factor authentication
   → "Begin enrollment" works exactly as before.

### Risks

- Backend changes are small and TypeScript-checked clean.
- Desktop changes are TypeScript-checked clean.
- No Rust changes in 1.3.1.

---

## 1.3.0 — 2026-05-11 — Phase 3b: SSH keys + TOFU + multi-tab

**Codename:** Many Sessions

### Scope summary

Three features layered on top of 1.2.0's SSH terminal:

1. **Private-key authentication** with optional passphrase
2. **Host-key verification (TOFU)** writing to `~/.netsphere/known_hosts`
3. **Multiple simultaneous terminal sessions** in a tab bar

Backend (Node.js) is unchanged. All work is in `desktop/` (Rust + React).

### Added

**Rust / Tauri side:**
- New module `src-tauri/src/commands/known_hosts.rs` — OpenSSH-compatible
  `known_hosts` file parser, writer, and TOFU verifier. File lives at
  `~/.netsphere/known_hosts`, mode 0o600, format compatible with
  `~/.ssh/known_hosts` so you can copy entries between the two.
- `ClientHandler::check_server_key` now consults the store. **First
  seen → pin**, **match → accept silently**, **mismatch → reject hard**
  and surface structured `host_key_changed` payload to the renderer.
- `AuthMethod` enum: `Password` and `PrivateKey { pem, passphrase }`.
  Wire format unchanged for password connects; key connects use
  `russh_keys::decode_secret_key` + `authenticate_publickey`.
- Three new IPC commands: `ssh_get_known_host`, `ssh_forget_known_host`,
  `ssh_list_known_hosts`.
- `passphrase` field on `SshConnectArgs` — in-memory only, not stored
  anywhere persistent.
- New error codes the renderer can switch on: `key_passphrase_required`,
  `key_invalid_passphrase`, `key_decode_failed`, `host_key_changed`.
- New crates: `base64 = 0.22`, `sha2 = 0.10`, `dirs = 5.0`.

**Desktop / React side:**
- `modules/sessions/store/terminalTabsStore.ts` — Zustand store for the
  list of open terminal tabs, with per-tab phase state machine.
- `modules/sessions/components/TerminalWorkspace.tsx` — top-level page
  with the tab bar at top + active pane below. Replaces the old
  single-session `TerminalPage`. Mounted at both `/terminal` (returns
  to current tabs) and `/hosts/:id/terminal` (opens or focuses a tab
  for that host).
- `modules/sessions/components/TerminalPane.tsx` — one tab's xterm +
  state machine. Each pane stays mounted (display:none toggled) even
  when its tab isn't visible, so sessions don't drop on tab switch.
- `PasswordPrompt` (handles both password and passphrase),
  `ErrorScreen`, `HostKeyChangedScreen` subcomponents.
- HostDetailPage now shows a **Host key (TOFU)** card with the stored
  SHA256 fingerprint and a "Forget" button for SSH hosts.
- Sidebar gains a "Terminal" entry to return to active tabs from
  anywhere in the app.

### Removed

- `modules/sessions/components/TerminalPage.tsx` — replaced by
  `TerminalWorkspace` + `TerminalPane`.

### Key behaviour decisions

These are the three design choices I made when you said "use your
judgement":

1. **Tabs are pane-local, not global.** The tab bar lives inside the
   `/terminal` page; the rest of the app's sidebar is unchanged.
   Navigating to Settings and back keeps the tabs alive. Closing the
   app kills them (persistence across restarts is 1.4.0).

2. **Host-key mismatch is hard-blocked.** A changed key is the strongest
   signal of a possible MITM attack — 1.3.0 refuses the connection and
   requires a deliberate "Forget old key and retry" click. No "proceed
   anyway" escape hatch, matching OpenSSH's strict-mode behaviour.

3. **Passphrases are session-memory only.** Encrypted private keys
   prompt at connect time. The passphrase is held in the connect
   request's payload, used once to decrypt, then dropped. Not written
   to disk, not stored in the credential record by default.

   (If you DO want persistent passphrase storage, you can add a
   `"passphrase"` field manually to the credential's `secret_data` JSON
   — the Rust side reads it as a fallback. Not exposed in the UI yet.)

### Known limitations (deferred to 1.4.0+)

- **No tab persistence across app restarts.** Closing NetSphere kills
  the tab list. Restoring sessions on launch is 1.4.0.
- **No automatic reconnect** when the network drops mid-session.
- **No SSH agent integration** (gnome-keyring / ssh-agent).
- **No SSH config import** from `~/.ssh/config`.
- **No port forwarding / jump hosts.** Phase 5.

### Risks I want to be upfront about

Same caveat as 1.2.0: I couldn't compile-test the Rust changes in my
sandbox (toolchain installer was blocked). The 1.2.0 russh API I used
worked verbatim — if 1.3.0 hits API mismatches they'll be in:
- `russh_keys::decode_secret_key` signature (key auth)
- `russh_keys::Error::KeyIsEncrypted` / `CouldNotReadKey` variants
- `PublicKey::public_key_bytes()` for fingerprinting

If `cargo build` fails, paste the first ~30 lines of cargo errors and
I'll send a 1.3.0.1 patch. The TypeScript / React side typechecks clean.

### How to upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.3.0.tar.gz --strip-components=1 --no-same-owner
make docker-up

cd desktop
npm install
npm run tauri dev       # incremental build, ~3-5 min (a few new crates)
```

The backend has no migrations to run. Your existing 1.2.0 hosts,
credentials, and history are preserved.

### Quick smoke test

1. **Existing host (password auth):** Click Connect on a host you've
   used before — should work identically to 1.2.0. **New:** check
   the host's detail page — you'll see a "Host key (TOFU)" card with
   the pinned fingerprint.
2. **New host (key auth):** Create a credential of type "Private key",
   paste an OpenSSH-format key (try `cat ~/.ssh/id_ed25519`), attach
   to a host, click Connect. Should land in shell without any password
   prompt.
3. **Encrypted key:** Same as 2 but use a passphrase-protected key.
   You should get the passphrase prompt at connect time.
4. **Multi-tab:** With one terminal open, navigate to Hosts and
   Connect to a different host. **A new tab should appear** — both
   sessions stay live. Switch between them with the tab bar.
5. **Host-key change (synthetic test):** Connect to a host once
   (pinning its key), then on the server change the SSH host key
   (`ssh-keygen -A` won't trigger this; you'd need to delete
   `/etc/ssh/ssh_host_*` and restart sshd, or test against a different
   machine with the same hostname). Reconnect — you should get the
   red "Host key changed" screen with both fingerprints displayed and
   no way forward except "Forget old key and retry".

### Migration notes

None. No database changes, no env changes.

---

## 1.2.0 — 2026-05-11 — Phase 3a: SSH terminal (incremental, part 1 of 3)

**Codename:** Connection

### Scope (deliberately narrow)

This is the first slice of Phase 3. It delivers an end-to-end SSH terminal
with **password authentication only**. Keys, agent, ssh-config integration,
multiple tabs, reconnect-on-failure, and SFTP are deferred to 1.3.0+ on
purpose — shipping a small, working surface first, then iterating.

### What works

- Click **Connect** on the Host Detail page (SSH hosts only)
- Type the SSH password in an inline prompt
- A full xterm.js terminal opens in-app
- Output streams bidirectionally (stdin from keyboard, stdout/stderr to
  terminal) over Tauri events
- Terminal resize is propagated to the remote PTY via `window_change`
- The connection is recorded in `connection_history` automatically:
  `POST /history/start` on connect, `POST /history/:id/end` on close
- The host's `last_used_at` and `use_count` are bumped via `/hosts/:id/touch`
- Disconnect cleanly via the button or by closing the tab

### What does NOT work in 1.2.0

- **Key authentication** — coming in 1.3.0. The credential field in the
  host form accepts only `password` type at runtime; `private_key`,
  `certificate`, `agent` will be rejected with `unsupported_credential_type`.
- **Host key verification (TOFU)** — 1.2.0 accepts any server key. 1.3.0
  will persist host keys to `~/.netsphere/known_hosts` and reject
  mismatches.
- **Multiple simultaneous sessions** — there's no tab UI yet; opening a
  second terminal navigates away from the first. The Rust backend already
  supports multiple sessions (each has its own UUID), so 1.3.0 just needs
  the UI.
- **Reconnect** — if the network drops, you have to start over.

### Added (Rust/Tauri side)

- `desktop/src-tauri/src/commands/ssh.rs` — full SSH client module using
  the `russh = "0.45"` crate
- New IPC commands: `ssh_connect`, `ssh_write`, `ssh_resize`,
  `ssh_disconnect`
- Per-session output streaming over Tauri events
  (`ssh:event:{session_id}`)
- Process-wide session registry (`Mutex<HashMap<String, SshSession>>`)
  protected by `once_cell::Lazy`
- HTTP client (via `reqwest` with `rustls-tls`) to call the backend's
  `/api/v1/hosts`, `/api/v1/credentials`, `/api/v1/history` endpoints
  from inside the Tauri process for credential resolution and history
  recording
- `AppError` type with structured `{code, message}` payload, serialized to
  JS so the renderer can switch on `code`

### Added (desktop side)

- `desktop/src/modules/sessions/components/TerminalPage.tsx` — xterm.js
  terminal with credential prompt, connecting/connected/disconnected/error
  states, and bidirectional event/IPC plumbing
- xterm.js dependencies: `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-web-links`
- New route: `/hosts/:id/terminal`
- Host Detail page's **Connect** button now opens the terminal for SSH
  hosts (disabled for other protocols)

### Risks I want to be upfront about

I built this against the documented `russh = "0.45"` API but **could not
compile-test the Rust code in my sandbox** — the toolchain installer was
blocked (`curl … sh.rustup.rs` returned HTTP 403). The TypeScript / desktop
side typechecks cleanly. If `cargo build` fails on your machine, the
errors will be small API-name mismatches (e.g. `Channel::data` vs
`make_writer`, `Handler` trait signature drift). I've already used
`make_writer()` for outbound bytes, which is the canonical idiom in
russh 0.45. **If it fails, paste the cargo errors and I'll patch
immediately in 1.2.0.1.**

### How to upgrade

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.2.0.tar.gz --strip-components=1 --no-same-owner
make docker-up

cd desktop
npm install
npm run tauri dev    # first build ~15-20 min as russh + reqwest compile
```

The backend has no changes in 1.2.0 — all the new code is in the desktop
(Rust + React). Migrations don't need to re-run.

### Quick smoke test

1. Sign in to the desktop
2. Open the SSH server you want to connect to (any normal Linux box or
   container running sshd)
3. Click **Hosts → New host**, set protocol = SSH, hostname = your server,
   port = 22, leave Credential empty (you'll be prompted for password)
4. Click the new host → **Connect**
5. Enter the password → you should land in a shell
6. Type `ls`, `pwd`, `exit` — try resizing the window, the remote PTY
   should re-flow
7. Click **Disconnect** or close the page
8. Go back to the host's detail page → "Recent connections" should now
   show one entry with status `closed`

### Migration notes

None required for the database (no migrations). The host's
`credential_id` field is still optional — you don't need a credential to
connect since you can type the password at the prompt.

---

## 1.1.2 — 2026-05-11 — Host list 500 fix

### Fixed

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Opening the **Hosts** page after upgrade returned "Internal Server Error" with zero rows in the DB. Backend logs showed PG error `08P01: bind message supplies 3 parameters, but prepared statement "" requires 1` at `HostRepository.list` (sessionRepos.ts:397). | `HostRepository.list` shared one mutable `params` array between the count query and the list query, then `params.push(limit, offset)` between the two `.query()` calls. Because both queries were `Promise.all`-awaited, both saw the post-mutation array. The count SQL had no `$N` placeholders for limit/offset, so PG rejected the bind. Classic shared-reference bug. | Each query now builds its own array via spread: `countParams = [...params]`, `listParams = [...params, limit, offset]`. Placeholders are computed off `listParams.length` so they stay stable. The same fix was applied preemptively to `ConnectionHistoryRepository.list` which had identical structure (would fail when filtering history by a non-trivial filter combination). |

### Why this slipped past my pre-ship test

The sandbox e2e test in 1.1.0 created a host then immediately listed — and at that point `params` only contained `[userId]` from the user-scope clause. The bug only manifests when both queries run together via `Promise.all` with the mutation happening between schedule and execution, which the test exercised but read past because no other filters were active. In testing terms: the bug needed two queries sharing state, and the test only checked the listed rows came back correctly — it didn't validate that 0-result lists also worked. **Lesson recorded:** Phase 2.x test additions should include "empty state" path coverage as a separate assertion, not just "happy path with data".

### Migration notes

In-place patch. No DB changes. Replace files and rebuild:

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.1.2.tar.gz --strip-components=1 --no-same-owner
make docker-up                      # rebuilds auth-service
```

Then refresh the desktop. The Hosts page should now load (showing the
empty state for new installs, or your real hosts if you had any).

---

## 1.1.1 — 2026-05-11 — MFA activation crash fix

### Fixed

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | After enabling 2FA and signing out, the next login attempt threw `Cannot read properties of undefined (reading 'id')` in the browser console and broke the MFA prompt | The desktop's `authStore.login` read `res.user.id` to remember which user was being challenged. The backend's MFA-required response only sent `{mfa_required, mfa_token}` — no user object — so the dereference blew up. Strict-TS didn't catch it because the desktop's `LoginResponse` type incorrectly declared `user: User` (non-optional) for the entire union of "MFA required" and "fully logged in" outcomes. | Two-pronged: (1) backend now includes a minimal `user` field in the MFA-required response so the MFA screen can show "Continue as alice"; (2) desktop relaxes `LoginResponse.user` to optional and uses `res.user?.id ?? null`. The backend fix alone would have unblocked you; the desktop fix prevents future recurrences from any client. |

### Migration notes

In-place patch — no database changes, no env changes. Replace the source
tree, rebuild the auth-service image, restart, refresh the desktop.

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down
tar xzf /path/to/netsphere-1.1.1.tar.gz --strip-components=1
make docker-up                       # rebuilds auth-service with the fix
cd desktop && npm run tauri dev      # picks up the type/store fix
```

Existing MFA enrollments are preserved.

---

## 1.1.0 — 2026-05-11 — Phase 2: Session Management

**Codename:** Sessions

### What's new

Phase 2 turns the auth shell into a real remote-administration tool by adding
the data model that Phase 3+ protocol handlers will consume.

- **Hosts** — first-class entities with hostname, port, protocol, credential
  reference, description, options blob, favorite flag, use counter,
  last-used timestamp
- **Folders** — hierarchical organization, self-referencing tree, with cycle
  detection on parent moves (recursive CTE in PG)
- **Tags** — flat many-to-many with hosts, with color
- **Credentials** — separate entities referenced by hosts. 6 credential types:
  password, private_key, certificate, agent, kerberos, none. One credential
  can serve many hosts.
- **Connection history** — append-only log with denormalized host name (so
  deleting a host doesn't erase the trail). Phase 3+ will populate this on
  connect / disconnect.

### Added (backend)

- Migration `005_session_management` — 6 tables, 3 new enum types,
  audit_action extended with `host_*`, `folder_*`, `tag_*`,
  `connection_*` events
- `src/domain/session.ts` — type contracts + Phase 2 domain errors
- `src/repos/sessionRepos.ts` — 5 repositories with user-scoping enforced at
  every query: FolderRepository, TagRepository, CredentialRepository,
  HostRepository (incl. tag M2M setTags/tagsOf/tagsForHosts), ConnectionHistoryRepository
- `src/routes/sessionMeta.ts` — Fastify plugins for `/folders`, `/tags`, `/credentials`
- `src/routes/sessionRoutes.ts` — Fastify plugins for `/hosts`, `/history`
- 23 new API endpoints under `/api/v1/{folders,tags,credentials,hosts,history}`

### Added (desktop)

- `src/modules/sessions/api/sessionsApi.ts` — full TypeScript API client
- `src/modules/sessions/components/HostsPage.tsx` — list view with folder
  tree, tag filter, search, protocol filter, favorites filter
- `src/modules/sessions/components/HostFormPage.tsx` — create/edit form with
  auto-port-from-protocol, multi-tag selection, folder/credential pickers
- `src/modules/sessions/components/HostDetailPage.tsx` — read-only host view
  with metadata grid, embedded credential summary + reveal button, recent
  connection history
- `src/modules/sessions/components/CredentialsPage.tsx` — list + modal form
  with type-specific fields (password, private_key, certificate, agent,
  kerberos, none) and reveal toggle
- `src/modules/sessions/components/TagsPage.tsx` — inline create/edit/delete
- `src/modules/sessions/components/FoldersPage.tsx` — tree management with
  parent reassignment and cycle prevention server-side
- Sidebar nav reorganized: Workspace section now lists Hosts / Credentials /
  Folders / Tags; Files / Network / Audit moved to "Coming soon"
- `src/vite-env.d.ts` — declared Vite env types (was missing in 1.0.0; latent
  TS error in `api.ts` line 15)

### API surface (frozen)

Public auth, authenticated user, and admin routes unchanged. New routes:

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/v1/folders` | Returns flat list AND tree shape |
| `POST`   | `/api/v1/folders` | |
| `PATCH`  | `/api/v1/folders/:id` | Cycle-protected on parent change |
| `DELETE` | `/api/v1/folders/:id` | Cascades to sub-folders |
| `GET`    | `/api/v1/tags` | |
| `POST`   | `/api/v1/tags` | |
| `PATCH`  | `/api/v1/tags/:id` | |
| `DELETE` | `/api/v1/tags/:id` | |
| `GET`    | `/api/v1/credentials` | Secrets stripped |
| `GET`    | `/api/v1/credentials/:id?reveal=true` | Includes `secret_data`; audit-logged |
| `POST`   | `/api/v1/credentials` | |
| `PATCH`  | `/api/v1/credentials/:id` | |
| `DELETE` | `/api/v1/credentials/:id` | |
| `GET`    | `/api/v1/hosts` | Filters: `folder_id`, `tag_ids`, `protocol`, `q`, `favorites_only`, `limit`, `offset` |
| `POST`   | `/api/v1/hosts` | Port auto-defaults from protocol |
| `GET`    | `/api/v1/hosts/:id` | Includes tags |
| `PATCH`  | `/api/v1/hosts/:id` | Supports `tag_ids` to replace tag set |
| `DELETE` | `/api/v1/hosts/:id` | |
| `POST`   | `/api/v1/hosts/:id/touch` | Used by Phase 3+ on connect |
| `POST`   | `/api/v1/hosts/:id/favorite` | Toggle |
| `GET`    | `/api/v1/history` | |
| `POST`   | `/api/v1/history/start` | |
| `POST`   | `/api/v1/history/:id/end` | |
| `DELETE` | `/api/v1/history?older_than=ISO` | Bulk delete |

### Fixed

| # | Issue | Resolution |
|---|---|---|
| 1 | `noUncheckedIndexedAccess` errors in migrate.ts when reading regex groups | Added explicit guards + non-null assertions where the regex guarantees presence |
| 2 | Vite's `import.meta.env` triggered TS2339 — pre-existing in 1.0.0, exposed when desktop typecheck ran clean otherwise | Added `src/vite-env.d.ts` with proper `ImportMetaEnv` declaration |

### Migration notes (upgrading from 1.0.0)

In-place upgrade is safe — the new tables don't touch any 1.0.0 data:

```bash
cd ~/netsphere
# Stop services
docker compose --env-file .env -f deployments/docker-compose.yml down

# Extract 1.1.0 over the existing tree (your .env is preserved)
tar xzf /path/to/netsphere-1.1.0.tar.gz --strip-components=1

# Bring everything back up; migrations 005 auto-applies via migrate-up-docker
make docker-up
make migrate-up-docker
docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service
```

**Note about audit_action enum:** `ALTER TYPE ADD VALUE` cannot be rolled
back in PostgreSQL. Once you upgrade, the new audit_action values
(`host_create`, `host_update`, `host_delete`, `folder_*`, `tag_*`,
`connection_*`) are permanently in your enum. This is a PG limitation, not
a bug. Rolling back the 005 migration drops the new tables but leaves the
enum values; that's intentional.

### Known limitations carried into Phase 3

1. **Credential secrets stored as plaintext JSONB.** Marked `TODO(Phase10)`
   in migration 005. Phase 10 will introduce envelope encryption with a KMS
   abstraction; API surface won't change.
2. **No SSH terminal yet.** Phase 3 adds the protocol handler. The Host
   data model already has the `protocol`, `options`, `credential_id` fields
   it needs.
3. **No cross-user host sharing.** All data is per-user. Phase 11 (Enterprise
   Sharing) will add team/group ACLs.
4. **No bulk import.** Importing from PuTTY / OpenSSH config / mRemoteNG is
   a Phase 2.x candidate.
5. **No drag-and-drop folder reorganization.** Move via the dropdown picker
   in the folder edit form.

---

## 1.0.0 — 2026-05-10 — Phase 1: Foundation

**Codename:** Foundation

This document records **every issue** found during the 1.0.0 release-candidate
process and the fix applied to each. Going forward, every release notes file
will append (not replace) entries — so the history is auditable.

---

## Headline changes from 1.0.0-rc to 1.0.0

| # | Area | Bug or change | Resolution |
|---|---|---|---|
| 1 | Backend language | Go backend's user lookup silently failed on `CITEXT` columns. 3 ms login latency was the telltale sign (real Argon2 verify is ~300 ms). | Rewrote backend in **Node.js + TypeScript + Fastify**. Migrations now use `TEXT` with application-side `lower()` normalization. |
| 2 | Admin seeding | Migration 005 baked an Argon2 hash into SQL. Dollar-sign escaping and shell expansion corrupted the hash on some paths. | Replaced the migration with **bootstrap-on-startup**: if `users` is empty, the live process hashes `BOOTSTRAP_ADMIN_PASSWORD` from `.env` and inserts a new admin. Zero SQL escaping risk. |
| 3 | Makefile portability | `$(CURDIR)` expanded unquoted on paths containing spaces (`/media/user/Old Data/...`), splitting docker-compose arguments. | Makefile rewritten to use **relative paths only**. Tested on paths with spaces. |
| 4 | docker-compose env | Compose looked for `.env` in `deployments/`, not the repo root, leading to silent `${POSTGRES_DB}` = empty string substitution. | Makefile invokes compose with explicit `--env-file .env` from the repo root. |
| 5 | docker-compose version key | `version: "3.9"` triggered an obsolete-attribute warning on modern Docker. | Removed. |
| 6 | api-gateway breaking auth-service build | api-gateway shared the same compose build run; its missing `go.sum` failed the whole build, cancelling auth-service. | Placed api-gateway behind the `gateway` profile (opt-in). Not built unless explicitly requested. |
| 7 | Missing `go.sum` in container build | The auth-service Dockerfile (Go era) couldn't generate `go.sum` automatically. | Added `go mod tidy` step. Moot for 1.0.0 (Node.js) but documented for posterity. |
| 8 | CITEXT incompatibility | pgx couldn't decode `CITEXT` into a Go `string` without a custom codec, silently failing user lookups. | Migrations changed to `TEXT`; application normalizes via `lower()`. |
| 9 | Vite env var not loading | Frontend's `VITE_API_BASE_URL` wasn't set, so login requests went to the wrong origin. Manifested as `NetworkError`. | Documented `desktop/.env` requirement explicitly. Vite reads its env from the desktop directory, not the repo root. |
| 10 | Tauri Rust toolchain | `dlopen2_derive` requires `edition2024` (Cargo 1.85+). Older Rust failed cryptically. | README now mandates Rust 1.85+. |
| 11 | Port 5432 conflict | Local host PostgreSQL claimed the same port the container wanted. | Added `POSTGRES_HOST_PORT` env var (defaults 5432, override to 5433 etc.) to remap host port without changing internal port. |
| 12 | Port 1420 (Vite) leftover | A previous Vite instance held the port; new runs failed with `EADDRINUSE`. | Documented kill commands (`fuser -k 1420/tcp`). |
| 13 | Migrations applied but admin missing | Bootstrap admin code ran *before* migrations completed (services started in parallel). Errored silently, no admin row created. | Documented mandatory sequence: `docker-up` → `migrate-up-docker` → restart `auth-service`. The restart triggers fresh bootstrap on the now-existing table. |
| 14 | Bootstrap admin not re-running | Once a row exists, bootstrap is skipped (correctly), so a failed bootstrap is sticky. | Reset procedure documented (`down -v` to wipe volumes). |
| 15 | Self-service password change | UI page existed but no backend endpoint. | Page stubbed with "Coming in Phase 2" notice. Admin password change via direct SQL documented in README. |
| 16 | Authenticator MFA confirmation route mismatch | Desktop called `/mfa/confirm`; backend exposed `/mfa/activate`. | Desktop API client renamed `mfaConfirm` → `mfaActivate`. |

---

## API surface (frozen for 1.0.0)

Subsequent phases may add endpoints. **None of the 1.0.0 endpoints will change shape** without a major version bump.

### Public

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | `{username, password}` | `{access_token, refresh_token, user}` or `{mfa_required, mfa_token}` |
| `POST` | `/api/v1/auth/refresh` | `{refresh_token}` | `{access_token, refresh_token}` |
| `POST` | `/api/v1/auth/mfa/verify` | `{code}` + Bearer `mfa_token` | `{access_token, refresh_token, user}` |
| `POST` | `/api/v1/auth/logout` | (none) | 204 |
| `GET`  | `/healthz` | — | `{status: "ok"}` |
| `GET`  | `/readyz`  | — | `{status: "ready"}` |

### Authenticated

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`   | `/api/v1/users/me` | — | user object |
| `PATCH` | `/api/v1/users/me` | `{full_name?, email?}` | updated user |
| `POST`  | `/api/v1/auth/mfa/enroll` | `{device_name}` | `{device_id, secret, otpauth_url, qr_code_png}` |
| `POST`  | `/api/v1/auth/mfa/activate` | `{device_id, code}` | 204 |

### Admin (role: `admin` or `super_admin`)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`    | `/api/v1/admin/users` | query: `limit`, `offset` | `{data, total, limit, offset}` |
| `POST`   | `/api/v1/admin/users` | `{username, email, password, full_name?, role}` | new user |
| `GET`    | `/api/v1/admin/users/:id` | — | user |
| `PATCH`  | `/api/v1/admin/users/:id` | partial user | updated user |
| `DELETE` | `/api/v1/admin/users/:id` | — | 204 |

---

## Verified test results

- ✅ TypeScript compiles cleanly with `--strict --noUncheckedIndexedAccess`
- ✅ All 159 npm dependencies install cleanly
- ✅ Migrations 001–004 apply against PostgreSQL 16
- ✅ Server starts, connects to DB, auto-creates bootstrap admin
- ✅ `POST /api/v1/auth/login` returns valid JWTs
- ✅ `GET /api/v1/users/me` with valid Bearer token returns user payload
- ✅ `GET /api/v1/admin/users` returns user list for admin role
- ✅ `POST /api/v1/auth/refresh` rotates tokens
- ✅ Bad password returns 401 in ~300 ms (genuine Argon2 verify)
- ✅ End-to-end login from browser (Vite + Fastify + Postgres) confirmed working

---

## Known limitations carried into Phase 2

1. **No self-service password change UI.** The page exists but the backend endpoint isn't implemented. Use direct SQL or wipe + re-bootstrap.
2. **No SMTP / password reset emails.** Phase 2 deliverable.
3. **TOTP secret stored as plain bytes in PostgreSQL.** Phase 10 will move this to envelope encryption with a KMS.
4. **Account lockout uses an in-database counter.** No external rate-limit store yet.
5. **Tauri icons are 1×1 PNG placeholders.** `tauri dev` is happy; `tauri build` will complain. Replace before shipping production builds.
6. **Apple/Windows signing not configured.** Linux .deb/.AppImage builds work.

---

## Upgrade policy

Every release going forward appends to this file. Format:

```
## X.Y.Z — YYYY-MM-DD

### Fixed
- short description (issue link / commit)

### Changed
- ...

### Added
- ...

### Migration notes
- step-by-step actions required when upgrading from the previous version
```

Never delete entries. The history is the audit trail.
