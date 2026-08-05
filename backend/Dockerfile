# =====================================================
# auth-service (Node.js / TypeScript) - multi-stage
# =====================================================
FROM node:20-alpine AS builder

# argon2 needs build tools to compile its native binding.
RUN apk add --no-cache python3 make g++

WORKDIR /src

COPY package.json ./
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npm run build

# Prune dev deps for the final image.
RUN npm prune --omit=dev

# =====================================================
FROM node:20-alpine

# wget+tini for runtime; iputils/traceroute power the Network diagnostics tools.
# openvpn powers backend-runtime VPN profiles. The container's main process runs
# as the non-root `app` user, but openvpn must create a tun device and shell out
# to `ip` to configure the interface/routes. Per-binary file capabilities are
# unreliable here (they don't carry into the `ip` child on many kernels), so
# make openvpn setuid-root: when `app` execs it, openvpn — and every `ip` it
# runs — is root and has the privileges it needs. The Node service stays
# non-root. Still needs `cap_add: NET_ADMIN` + the /dev/net/tun device from
# docker-compose.production.yml so NET_ADMIN is in the container's bounding set.
# iptables powers VPN-server internet routing (NAT/MASQUERADE for full-tunnel
# clients); the manager adds/removes rules at runtime (needs NET_ADMIN).
RUN apk add --no-cache wget tini iputils traceroute openvpn iproute2 iptables \
 && chmod u+s "$(command -v openvpn)"

WORKDIR /app

COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Drop privileges
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app
USER app:app

ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations

EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD wget -qO- http://localhost:8081/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
