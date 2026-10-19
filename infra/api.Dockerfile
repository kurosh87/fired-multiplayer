# syntax=docker/dockerfile:1
# Public multi-architecture Node 24 image, resolved October 16, 2026.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /opt/kanto
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace=@kanto/server --include-workspace-root --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ARG SOURCE_SHA256
LABEL io.kanto.source-sha256=$SOURCE_SHA256
WORKDIR /opt/kanto
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 GAME_WORKER_TRANSPORT=process PUBLIC_RELEASE=false
COPY --from=dependencies /opt/kanto/node_modules ./node_modules
COPY package.json ./package.json
COPY apps/server ./apps/server
COPY packages ./packages
COPY infra/inspect-linux-runtime.ts ./infra/inspect-linux-runtime.ts
RUN mkdir -p /opt/kanto/artifacts
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "apps/server/src/main.ts"]
