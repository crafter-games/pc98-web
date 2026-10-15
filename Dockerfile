# Builds the WASM cores and the web app, then serves it as static files.
FROM emscripten/emsdk:6.0.12 AS build
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build git && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && npm install -g pnpm@11.22.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY . .
RUN ./native/build.sh && pnpm --filter @pc98-web/core build && pnpm --filter @pc98-web/web exec vite build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/web/dist /usr/share/nginx/html
EXPOSE 80
