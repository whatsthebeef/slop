# One image: the server serves the API, MCP, SSE and the built board.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @slop/core build && pnpm --filter @slop/server build && pnpm --filter @slop/web build
RUN pnpm deploy --filter @slop/server --prod --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production WEB_DIST=/app/web MIGRATIONS_DIR=/app/drizzle CATALOG_DIR=/app/catalog PORT=3000
COPY --from=build /out .
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./web
COPY catalog ./catalog
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
