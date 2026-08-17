# =============================================================================
# LILG — Multi-stage Dockerfile
# Stage 1: builder  — compile TypeScript
# Stage 2: runner   — minimal production image (non-root)
# =============================================================================

# ---- Stage 1: builder -------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS builder

WORKDIR /app

# Install dependencies first (layer cache friendly)
# Pin apk package versions (Checkmarx / supply-chain).
COPY package*.json ./
RUN apk add --no-cache \
      python3=3.12.14-r0 \
      make=4.4.1-r3 \
      g++=14.2.0-r6 \
    && npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
COPY connectors/ad-agent ./connectors/ad-agent
RUN npm run build \
    && npx tsc --project connectors/ad-agent/tsconfig.json

# Prune dev dependencies so we can copy node_modules cleanly
RUN npm prune --production

# ---- Stage 2: runner --------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS runner

# Security hardening — pin apk versions
RUN apk add --no-cache \
      dumb-init=1.2.5-r3 \
      wget=1.25.0-r1 \
    && addgroup -g 1001 lilg \
    && adduser -u 1001 -G lilg -s /sbin/nologin -D lilg \
    && mkdir -p /app/data/saml \
    && chown -R lilg:lilg /app/data

WORKDIR /app

# Copy artefacts from builder
COPY --from=builder --chown=lilg:lilg /app/dist ./dist
COPY --from=builder --chown=lilg:lilg /app/node_modules ./node_modules
COPY --from=builder --chown=lilg:lilg /app/package.json ./package.json
COPY --chown=lilg:lilg web ./web
COPY --chown=lilg:lilg migrations ./migrations
COPY --from=builder --chown=lilg:lilg /app/connectors/ad-agent ./connectors/ad-agent

# Expose HTTP and HTTPS ports
EXPOSE 8080
EXPOSE 8443

# Liveness probe
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

# Drop to non-root
USER lilg

# Use dumb-init so node is not PID 1 (proper signal handling)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
