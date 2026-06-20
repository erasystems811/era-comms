# ── BUILD STAGE ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src/ ./src/

RUN npm run build

# ── PRODUCTION STAGE ──────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Native addons (Baileys uses libsodium / bufferutil)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY infra/ ./infra/

ENV NODE_ENV=production
EXPOSE 3000

# Migrate then start the server
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
