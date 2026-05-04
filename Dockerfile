# MediaCreator BullMQ worker — minimal Node 20 Alpine image.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
# Non-root user for defense in depth.
USER node
CMD ["node", "dist/src/index.js"]