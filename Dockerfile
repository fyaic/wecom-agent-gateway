FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV NODE_ENV=production
ENV GATEWAY_OBSERVABILITY_ENABLED=true
ENV GATEWAY_OBSERVABILITY_HOST=127.0.0.1
ENV GATEWAY_OBSERVABILITY_PORT=9464
ENV GATEWAY_DATABASE_PATH=/var/lib/wecom-agent-gateway/gateway.db
ENV GATEWAY_MEDIA_SPOOL_ROOT=/var/lib/wecom-agent-gateway/media-spool
ENV GATEWAY_CONTROL_SOCKET=/var/lib/wecom-agent-gateway/gateway-control.sock

RUN npm install --global pnpm@11.8.0 tsx@4.23.1 \
  && npm cache clean --force
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod --no-optional

RUN groupadd --system --gid 10001 gateway \
  && useradd --system --uid 10001 --gid gateway --home-dir /var/lib/wecom-agent-gateway gateway \
  && mkdir -p /var/lib/wecom-agent-gateway/agent-output \
  && chown -R gateway:gateway /app /var/lib/wecom-agent-gateway

USER 10001:10001
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["pnpm", "healthcheck"]
CMD ["pnpm", "start"]
