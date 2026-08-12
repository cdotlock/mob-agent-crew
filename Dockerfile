FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git gosu && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
    && curl -fsSL https://omp.sh/install | sh \
    && install -m 0755 /root/.local/bin/omp /usr/local/bin/omp

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

RUN mkdir -p /data && chmod 0755 /usr/local/bin/docker-entrypoint

EXPOSE 4310
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/cli.js", "start"]
