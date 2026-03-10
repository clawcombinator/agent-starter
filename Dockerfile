# ============================================================
# Multi-stage build: compile TypeScript, then run lean image
# ============================================================

# ------- Stage 1: build -------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ------- Stage 2: runtime -------
FROM node:20-alpine AS runtime

# Security: run as non-root
RUN addgroup -S agent && adduser -S agent -G agent

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Config files (capabilities.yaml, safety.yaml)
COPY config/ ./config/

# Create writable logs directory, owned by non-root user
RUN mkdir -p logs && chown agent:agent logs

USER agent

EXPOSE 8080

# Health check — polls /health every 30s; 3 consecutive failures = unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
