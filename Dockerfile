# Standard-MSA production image. `docker compose up` builds this and runs it
# with a persistent SQLite volume; see docker-compose.yml.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npx next build
# Prisma CLI + its *whole* dependency closure, staged for the run stage.
# Computed from this install tree rather than listed, so a Prisma bump needs
# no edit here; see scripts/collect-prisma-cli.ts for why (SHA-4378).
RUN npx tsx scripts/collect-prisma-cli.ts /prisma-cli

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# Pin the listen address. The standalone server.js binds
# `process.env.HOSTNAME || '0.0.0.0'`, so whatever the platform leaves in
# HOSTNAME becomes the bind address — and container runtimes commonly set it
# to the container id. Measured with that exact expression, each failure goes
# a different direction: a name that does not resolve is a hard listen failure
# (EAI_AGAIN, exit 1 — a crash loop); a name that resolves to one routable
# address binds only that address, so the edge reaches it while in-container
# loopback gets ECONNREFUSED (a localhost health check fails on a service that
# is up); `localhost` binds ::1 only, the reverse. None of the three is
# visible in a boot log. Set it here so the image does not depend on the
# platform leaving HOSTNAME alone (SHA-4378).
# PORT needs no default: server.js already falls back to 3000, which is what
# EXPOSE and docker-compose.yml publish. Platforms that inject PORT win.
ENV HOSTNAME=0.0.0.0
# Standalone output: server.js + minimal node_modules, no full install.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Schema + migrations, and the Prisma CLI for `migrate deploy` at container
# start. The CLI gets its own self-contained tree: it keeps the standalone
# bundle's traced `@prisma/client` from being overwritten by the dev-tree
# copy, and it is the layout docker-entrypoint.sh resolves the CLI from.
COPY --from=build /app/prisma ./prisma
COPY --from=build /prisma-cli/node_modules ./prisma-cli/node_modules
COPY docker-entrypoint.sh ./docker-entrypoint.sh
EXPOSE 3000
CMD ["sh", "./docker-entrypoint.sh"]
