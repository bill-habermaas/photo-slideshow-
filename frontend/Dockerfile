# ---- build & test ----------------------------------------------------------
# Debian-based (not alpine) because TypeScript 7 and Vite ship native glibc binaries.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Unit tests run as part of the image build (skip with --build-arg SKIP_TESTS=true).
ARG SKIP_TESTS=false
RUN if [ "$SKIP_TESTS" != "true" ]; then npm test; fi
RUN npm run build

# ---- runtime: nginx serves the app and proxies /api to the Go container --------
FROM nginx:1-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
