FROM node:24-trixie AS build

RUN npm install --global pnpm@12.4.2

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches

RUN --mount=type=cache,id=clowder-pnpm,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

COPY . .

# Install scripts only generate web env types and SvelteKit files, which the docs never use.
RUN --mount=type=cache,id=clowder-pnpm,target=/pnpm/store \
    pnpm install --prod=false --offline --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
    && pnpm --filter @clowder/docs build

# Every page is prerendered, so the image is just a static file server.
FROM caddy:2-alpine

COPY apps/docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/docs/dist /srv

EXPOSE 80
