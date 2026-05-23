# =============================================================================
# LILG — Multi-stage Dockerfile
# Stage 1: builder  — compile TypeScript
# Stage 2: runner   — minimal production image (non-root)
# =============================================================================

# ---- Stage 1: builder -------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so we can copy node_modules cleanly
RUN npm prune --production

# ---- Stage 2: runner --------------------------------------------------------
FROM node:22-alpine AS runner

# Security hardening
RUN apk add --no-cache dumb-init wget \
    && addgroup -g 1001 lilg \
    && adduser -u 1001 -G lilg -s /sbin/nologin -D lilg

WORKDIR /app

# Copy artefacts from builder
COPY --from=builder --chown=lilg:lilg /app/dist ./dist
COPY --from=builder --chown=lilg:lilg /app/node_modules ./node_modules
COPY --from=builder --chown=lilg:lilg /app/package.json ./package.json
COPY --chown=lilg:lilg web ./web
COPY --chown=lilg:lilg migrations ./migrations

# Expose HTTP port
EXPOSE 8080

# Liveness probe
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

# Drop to non-root
USER lilg

# Use dumb-init so node is not PID 1 (proper signal handling)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
