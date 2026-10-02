# =====================================================
# auth-service (Node.js / TypeScript) - multi-stage
# =====================================================
FROM node:20-alpine AS builder

# argon2 needs build tools to compile its native binding.
RUN apk add --no-cache python3 make g++

WORKDIR /src

# SEC-RELEASE-001: install EXACTLY the audited lockfile (reproducible build;
# a plain `npm install` would re-resolve ^ranges at build time).
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
RUN npm run build

# Prune dev deps for the final image.
RUN npm prune --omit=dev

# =====================================================
FROM node:20-alpine

# SEC-INFRA-001 — the Internet-facing backend is UNPRIVILEGED. It does NOT
# contain the openvpn binary and never spawns OpenVPN: all privileged VPN work is
# delegated to the isolated `awamer-vpn-helper` container over an authenticated
# Unix socket. This image therefore installs NO openvpn / iproute2 and sets no
# setuid bit. `iputils`/`traceroute` remain for the Network diagnostics tools
# (they use unprivileged sockets; they do not need NET_ADMIN). tini reaps procs.
RUN apk add --no-cache wget tini iputils traceroute

WORKDIR /app

COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Drop privileges — the service runs as a dedicated non-root user. There is no
# openvpn/setuid in this image and no NET_ADMIN in the container, so a compromise
# here cannot obtain privileged network-control capabilities.
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app
USER app:app

ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations

EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD wget -qO- http://localhost:8081/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
