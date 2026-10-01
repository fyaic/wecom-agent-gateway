FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV NODE_ENV=production
ENV GATEWAY_OBSERVABILITY_ENABLED=true
ENV GATEWAY_OBSERVABILITY_HOST=127.0.0.1
ENV GATEWAY_OBSERVABILITY_PORT=9464
ENV GATEWAY_DATABASE_PATH=/var/lib/wecom-agent-gateway/gateway.db
ENV GATEWAY_OWNER_LOCK_ROOT=/var/lib/wecom-agent-gateway/owner-locks
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
