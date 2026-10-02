# Dependency Security Report

Tools executed during this assessment:
- `npm audit --json` (all dependencies) and `npm audit --omit=dev --json` (runtime only), for `backend/` and `desktop/`.
- `cargo audit` 0.22.2, installed in this session, against the RustSec advisory DB, for `desktop/src-tauri/Cargo.lock`.

Major upgrades were not applied blindly. Every change below is either within the existing
semver range, or a major bump whose breaking changes were read and checked against our usage.

## 1. Changes made

| Package | Before | After | Type | Why |
|---|---|---|---|---|
| fastify (backend, runtime) | 5.11.2 | **5.12.5** | in-range (`^5.11.2`) | 7 advisories, including an *authentication bypass via malformed URLs reaching not-found handlers* and *X-Forwarded-\* spoofing under trustProxy* |
| fast-uri (backend, runtime, via fastify/ajv) | 3.1.5 / 4.1.2 | **3.1.8 / 4.2.1** | in-range | SSRF / host-confusion advisories |
| nodemailer (backend, runtime) | 9.0.1 | **10.0.13** | **major** | Patched only in ≥10.0.9: DoS in the address parser, recipient-domain bypass, and cross-transport TLS servername reuse. The only 10.0.0 breaking change is "Node ≥ 20" (already `engines.node >=20`; images are `node:20-alpine`). Our use is `createTransport` + `sendMail`. One type import was adjusted (`Transporter`) |
| brace-expansion, js-yaml, esbuild (backend, dev/transitive) | — | patched | in-range | CPU-DoS advisories |
| react-router-dom / react-router (desktop, runtime) | 6.x | **6.30.6** | in-range | latest 6.x (does not clear the advisory; see below) |
| fflate (desktop, runtime via kdbxweb) | 0.7.4 | **0.7.5** | in-range | infinite loop on malformed ZIP64 |
| browserslist, nanoid, js-yaml, brace-expansion, postcss-selector-parser, baseline-browser-mapping (desktop, dev) | — | patched | in-range | build tooling |
| rustls (desktop, runtime via reqwest) | 0.23.40 | **0.23.45** | patch | RUSTSEC-2026-0285 |
| quinn-proto (desktop, in lockfile, not compiled) | 0.11.14 | **0.11.15** | patch | RUSTSEC-2026-0185 |

Also: both Dockerfiles now `COPY package-lock.json` and run **`npm ci`**. Before, they ran
`npm install`, which re-resolved ranges at build time, so production images never used the
audited lockfile.

## 2. Remaining findings (after changes)

### Backend: `npm audit --omit=dev` = 2 high, 1 moderate (all = runtime; there are no dev-only findings left)

| Package | Installed | Severity | Runtime reachable? | Production impact | Fix available? | Breaking? | Action |
|---|---|---|---|---|---|---|---|
| @fastify/static (via @fastify/swagger-ui) | 9.3.0 | High (route-guard bypass / non-canonical paths) | **Only if `ENABLE_API_DOCS=true`**. Swagger UI is registered only behind that flag (default off), and nginx proxies only `/api/`, `/healthz`, `/readyz`, so `/docs` is not exposed through the shipped proxy | None with the default config | yes, swagger-ui 6.1.1 | major | Keep `ENABLE_API_DOCS` unset in production (condition C-5); upgrade swagger-ui in the next maintenance window |
| @fastify/swagger-ui | 5.2.6 | Moderate | same | same | 6.1.1 | major | same |
| node-forge | 1.4.0 | High (RSA PKCS#1 v1.5 **signature verification** accepts extra DigestAlgorithm elements) | **No.** `vpn/pki.ts` only *generates* keys and *signs* certificates (`createCertificate`, `sign`, PEM conversion); no `verify` call exists in the codebase | None | **no fix upstream** | — | Accept; re-audit when a fix ships; optionally migrate PKI to `node:crypto` / `@peculiar/x509` |

### Desktop (npm): `npm audit --omit=dev` = 2 moderate (runtime); all = 1 critical, 1 high, 5 moderate

| Package | Installed | Severity | Runtime reachable? | Production impact | Fix | Breaking? | Action |
|---|---|---|---|---|---|---|---|
| react-router / react-router-dom | 6.30.6 | Moderate (open redirect via backslash in `<Link>`/`navigate`; SSR hydration issue) | Code reviewed: every `navigate()`/`<Link to>` target is a constant or a server-issued UUID path; no user-controlled URL reaches the router. No SSR | Low | 7.18.4 | **major** (v6 → v7) | Accept; plan the v7 migration |
| vitest / @vitest/mocker / vite-node | 2.1.9 | **Critical** / moderate | **No: dev only.** The Vitest UI server is not used in CI or production | None | vitest 5 | major | Upgrade with the dev toolchain |
| vite / esbuild | 5.4.21 | High / moderate | **No: dev server only.** Production ships static `dist/` | None | vite 8 | major | Upgrade with the dev toolchain |

### Desktop Rust (`cargo audit`): 5 vulnerabilities after changes

| Crate | Installed | Advisory | Severity | Runtime reachable? | Production impact | Fix | Breaking? | Action |
|---|---|---|---|---|---|---|---|---|
| russh | 0.45.0 | RUSTSEC-2026-0154 unbounded 32-bit allocation | High (A:H) | **Yes**: desktop native SSH client | A **malicious or compromised SSH server** the user connects to can crash or exhaust the desktop client (client-side DoS; no confidentiality or integrity impact) | ≥0.60.3 | **major** (0.45 → 0.60 API changes) | **Remaining risk R-01**; schedule the russh upgrade |
| russh-cryptovec | 0.7.3 | RUSTSEC-2026-0153 unchecked allocation | High (A:H) | Yes (via russh) | same | ≥0.60.3 | major | same |
| rsa | 0.9.10 | RUSTSEC-2023-0071 Marvin timing side-channel | Medium (C:H, AC:H) | Yes (russh-keys RSA client-key signing) | Requires an attacker who can measure many private-key operations; negligible for interactive SSH client auth | **none upstream** | — | Accept; prefer Ed25519 client keys |
| quick-xml | 0.39.4 | RUSTSEC-2026-0194/0195 | High (A:H) | **Build time only**: `plist` in `tauri-utils` / codegen | None at runtime | ≥0.41 | via Tauri | Upgrade with Tauri |
| *(warnings)* | — | unmaintained `proc-macro-error`, `unic-*`; unsound `anyhow::downcast_mut`, `glib` VariantStrIter; yanked `spin 0.9.8` | — | build/transitive | — | — | — | track |

## 3. Conclusion

- **No critical runtime-reachable dependency vulnerability remains.** The only critical
  (vitest) is dev tooling.
- The remaining runtime **high** findings are:
  - (a) unreachable with the shipped configuration (`@fastify/static`, `node-forge`);
  - (b) build-time only (`quick-xml`);
  - (c) a desktop client DoS by a malicious server (`russh`). That one is a real but bounded
    risk (availability of one user's client) and needs a major upgrade, so it is a
    **condition**, not a blocker.
