# SkyShelf backend (Node.js 20 + Fastify + PostgreSQL)
FROM node:20-alpine

WORKDIR /app

# tini — корректная обработка сигналов (PID 1)
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    SERVER_ADDRESS=0.0.0.0 \
    APP_STORAGE_DIR=/data/objects

VOLUME /data
EXPOSE 8080

USER node
# tini — корректная обработка сигналов; healthcheck стучится в /api/health
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
