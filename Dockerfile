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
ENV NODE_ENV=production WEB_DIST=/app/web MIGRATIONS_DIR=/app/drizzle CATALOG_DIR=/app/catalog DOCS_DIR=/app/docs SKILLS_DIR=/app/skills PORT=3000
COPY --from=build /out .
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./web
# git: the code view's clones and the reviewer's searches (read-only fetch, ls-tree, grep and log; nothing is checked out or run).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY catalog ./catalog
# Slop's help: only the spec and the feature guide are indexed (the rest of docs/ stays out of the image).
COPY docs/slop_behaviour_architecture_spec.md docs/guide.md ./docs/
# The Claude app skills, served as zips from the board.
COPY skills ./skills
# The files a deploy runs on the host (infra/deploy/deploy.sh extracts them from the pulled image).
COPY compose.prod.yaml ./deploy/compose.yaml
COPY infra/deploy/remote-deploy.sh infra/deploy/deploy-guards.sh infra/deploy/backup.sh ./deploy/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
