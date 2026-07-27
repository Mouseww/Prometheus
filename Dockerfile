# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS web-build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/agent-core/package.json packages/agent-core/tsconfig.json packages/agent-core/tsconfig.build.json ./packages/agent-core/
COPY packages/agent-core/src ./packages/agent-core/src
COPY apps/client/package.json apps/client/tsconfig.json apps/client/tsconfig.app.json apps/client/tsconfig.node.json apps/client/vite.config.ts apps/client/index.html ./apps/client/
COPY apps/client/src ./apps/client/src
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @prometheus/protocol build && pnpm --filter @prometheus/client build

FROM rust:1-bookworm AS server-build
WORKDIR /src
COPY apps/server-rs ./apps/server-rs
RUN cargo build --release --manifest-path apps/server-rs/Cargo.toml

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# 容器默认绑定 0.0.0.0，因此 PROMETHEUS_ACCESS_TOKEN 是必填项：
# 控制平面持有工作区读写与 shell 执行能力，无凭证暴露到网络等同于开放 RCE。
# 未设置时 server 会在 bind 之前拒绝启动，而不是静默放行。
#   docker run -e PROMETHEUS_ACCESS_TOKEN="$(openssl rand -hex 32)" ...
# 交互式终端（PTY + /api/terminal/exec）默认关闭；如需开启：
#   -e PROMETHEUS_TERMINAL_MODE=approval  （每次开终端都要走审批，网络绑定下唯一可选值）
# PROMETHEUS_ALLOWED_ORIGINS 为逗号分隔的浏览器来源白名单，留空则仅允许本机开发地址。
ENV PROMETHEUS_HOST=0.0.0.0 \
    PROMETHEUS_PORT=4310 \
    PROMETHEUS_DATA_FILE=/data/prometheus.db \
    PROMETHEUS_WEB_ROOT=/app/web \
    PROMETHEUS_WORKSPACE_ROOT=/workspace \
    PROMETHEUS_TERMINAL_MODE=disabled
WORKDIR /app
COPY --from=server-build /src/apps/server-rs/target/release/prometheus-server /usr/local/bin/prometheus-server
COPY --from=web-build /app/apps/client/dist /app/web
VOLUME ["/data", "/workspace"]
EXPOSE 4310
CMD ["prometheus-server"]
