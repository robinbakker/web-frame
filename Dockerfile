# syntax=docker/dockerfile:1
FROM node:26-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=optional
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Shared application files and privilege-dropping support, without browser layers.
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends gosu && \
    mkdir -p /app/data /app/output && chown -R node:node /app && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node public/ ./public/
COPY docker-entrypoint.sh /usr/local/bin/web-frame-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/web-frame-entrypoint && \
    chmod 755 /usr/local/bin/web-frame-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/web-frame-entrypoint"]
CMD ["run"]

FROM runtime AS slim
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Last stage remains the full default image for existing builds and Compose files.
FROM runtime AS playwright
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev --include=optional && \
    npx --no-install playwright install --with-deps chromium-headless-shell && \
    chown -R node:node /app /ms-playwright && \
    npm cache clean --force && apt-get clean && rm -rf /var/lib/apt/lists/*
USER node
