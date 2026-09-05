# syntax=docker/dockerfile:1.7
FROM node:24.4.1-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.4.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 linerecall \
  && useradd --system --uid 10001 --gid linerecall --home-dir /nonexistent --shell /usr/sbin/nologin linerecall
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY --from=build --chown=10001:10001 /workspace/dist ./dist
USER 10001:10001
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# Select with `docker build --target lichess-worker ...`. It intentionally has
# no HTTP health check; the token-owned Redis readiness lease is the worker's
# externally observed health signal.
FROM runtime AS lichess-worker
HEALTHCHECK NONE
CMD ["node", "--enable-source-maps", "dist/jobs/lichess-sync-worker.js"]

# Preserve the API image as the Dockerfile default target.
FROM runtime AS final
