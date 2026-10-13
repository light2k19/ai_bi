# AI BI — production image
#
#   docker build -t aibi .                       with a headless Chromium for PDF export (default)
#   docker build -t aibi --build-arg WITH_PDF=0 . without a browser: smaller image, no PDF export
#   docker run -d -p 8787:8787 -p 8788:8788 -v /srv/aibi/data:/data aibi     (or use docker-compose.yml)
#
# Everything the app stores lives in /data (mount it): the metadata database, the encryption key,
# uploaded skills, vendored modules, packages, imports, local SQLite files and backups. Replacing the
# image keeps all of it; pending schema changes are applied on start after an automatic backup.

# ── build the web app and the page runtime ──────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/runtime/package.json apps/runtime/
COPY apps/server/package.json apps/server/
COPY packages/cli/package.json packages/cli/
COPY packages/page-spec/package.json packages/page-spec/
COPY packages/runtime-api/package.json packages/runtime-api/
COPY packages/skill-sdk/package.json packages/skill-sdk/
COPY packages/sql-guard/package.json packages/sql-guard/
COPY packages/transforms/package.json packages/transforms/
COPY skills ./skills
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build -w @aibi/cli

# ── production dependencies only ────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/apps/runtime/package.json apps/runtime/
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/packages ./packages
COPY --from=build /app/skills ./skills
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    # browser-only packages that the server never loads (they are bundled into the runtime at build time)
    && rm -rf node_modules/echarts node_modules/zrender node_modules/lucide-react

# ── runtime image ───────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
ARG WITH_PDF=1
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    RUNTIME_PORT=8788 \
    AIBI_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN mkdir -p /data && chown node:node /data /app
COPY --chown=node:node --from=deps /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
# Playwright's headless Chromium shell renders PDF exports and AI preview screenshots: far smaller than a
# distribution Chromium with its desktop and media libraries. The export skill finds it by itself.
RUN if [ "$WITH_PDF" = "1" ]; then \
      node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/* /root/.cache; \
    fi
COPY --chown=node:node --from=deps /app/apps/web/package.json apps/web/
COPY --chown=node:node --from=deps /app/apps/runtime/package.json apps/runtime/
COPY --chown=node:node --from=deps /app/apps/server/package.json apps/server/
COPY --chown=node:node --from=deps /app/packages ./packages
COPY --chown=node:node --from=deps /app/skills ./skills
COPY --chown=node:node --from=build /app/apps/server ./apps/server
COPY --chown=node:node --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --chown=node:node --from=build /app/tools/backup.mjs ./tools/backup.mjs
COPY --chown=node:node --from=build /app/tsconfig.base.json /app/tsconfig.json ./
USER node
VOLUME ["/data"]
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
