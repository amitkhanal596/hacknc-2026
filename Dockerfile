FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY server/src ./server/src
COPY scripts ./scripts
COPY web ./web
RUN bun run typecheck && bun test && bun run build

FROM oven/bun:1.4.3 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DEMO_MODE=false
ENV DATABASE_URL=/app/.data/tab.sqlite TREASURY_KEY_PATH=/app/.data/treasury.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/.data && chmod 700 /app/.data
EXPOSE 3000
CMD ["bun", "server/src/index.ts"]
