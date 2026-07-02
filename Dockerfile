# ========== Stage 1: Build ==========
FROM node:20-slim AS builder
WORKDIR /app

# Install Node dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
COPY web/ web/
COPY vite.config.ts tailwind.config.js postcss.config.js ./

# Build: TypeScript API + Vite WebUI
RUN npm run build

# Prune dev dependencies (keep for npm audit at runtime if needed)
RUN npm prune --omit=dev

# ========== Stage 2: Runtime ==========
FROM node:20-slim AS runner
WORKDIR /app

# Create non-root user
RUN groupadd -r sag && useradd -r -g sag sag

# Production dependencies only
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

# SQL migrations (needed at runtime for db:migrate)
COPY migrations/ ./migrations/

# Environment
ENV NODE_ENV=production

EXPOSE 4173

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4173/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER sag
CMD ["node", "dist/src/index.js"]
