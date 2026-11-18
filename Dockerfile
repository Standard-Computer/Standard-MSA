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

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# Standalone output: server.js + minimal node_modules, no full install.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Prisma CLI + schema for `migrate deploy` at container start.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY docker-entrypoint.sh ./docker-entrypoint.sh
EXPOSE 3000
CMD ["sh", "./docker-entrypoint.sh"]
