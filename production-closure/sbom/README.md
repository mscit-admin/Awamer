# SBOMs (CycloneDX)

| File | Scope | Format | Components | Generated with |
|---|---|---|---:|---|
| `backend-runtime.cdx.json` | Backend production dependencies (`--omit dev`) | CycloneDX 1.5 | 168 | `cd backend && npm sbom --sbom-format cyclonedx --omit dev` (npm 10.9.4) |
| `desktop-frontend-runtime.cdx.json` | Web/desktop frontend runtime dependencies | CycloneDX 1.5 | 32 | `cd desktop && npm sbom --sbom-format cyclonedx --omit dev` |
| `desktop-tauri-rust.cdx.json` | Tauri desktop crate (Rust), incl. `russh 0.63.3` | CycloneDX 1.3 | 456 | `cd desktop/src-tauri && cargo cyclonedx --format json` (cargo-cyclonedx, installed this session) |

All three were generated from the release lockfiles (1.8.0). They describe the code dependencies, not the OS packages of the container images.

## Container images (OS packages): not generated here

The production images could not be built in this environment (Alpine package mirror blocked, see `../DOCKER_BUILD_EVIDENCE.md`). Generate in CI or on the build host, right after building:

```bash
V=1.8.0
syft netsphere/auth-service:$V -o cyclonedx-json > sbom/auth-service-image.cdx.json
syft netsphere/vpn-helper:$V   -o cyclonedx-json > sbom/vpn-helper-image.cdx.json
# optional vulnerability scan of the same images
grype netsphere/auth-service:$V --fail-on critical
grype netsphere/vpn-helper:$V   --fail-on critical
```

Store the image SBOMs next to these files, keyed by the image digest (`docker image inspect --format '{{.Id}}'`).
