# MediaCreator BullMQ worker — minimal Node 24 LTS Alpine image.
# Pinned to an exact patched release (Oct 21 2026 Node security release: Brotli
# RCE, TLS hostname bypasses, Undici). Never float to a bare major tag — the
# deployed runtime must be provable from this file. Bump deliberately.
FROM node:24.22.1-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:24.22.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && apk add --no-cache ffmpeg \
    && ffmpeg -version >/dev/null \
    && ffprobe -version >/dev/null
COPY --from=builder /app/dist ./dist
# Non-root user for defense in depth.
USER node
CMD ["node", "dist/src/index.js"]
