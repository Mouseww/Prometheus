FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @prometheus/web build

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
RUN corepack enable && useradd -m -u 10001 prometheus && mkdir /data /workspace && chown prometheus /data /workspace
COPY --from=build --chown=prometheus /app /app
USER prometheus
ENV PROMETHEUS_HOST=0.0.0.0 \
    PROMETHEUS_PORT=7420 \
    PROMETHEUS_HOME=/data \
    PROMETHEUS_CWD=/workspace
VOLUME ["/data", "/workspace"]
EXPOSE 7420
# PROMETHEUS_TOKEN (>=16 chars) is required at runtime; the server refuses to listen publicly without it.
CMD ["node", "apps/server/src/main.ts"]
