ARG GATEWAY_IMAGE=wecom-agent-gateway:linux-lab-base
FROM ${GATEWAY_IMAGE}

# An isolated, credential-free Linux preflight image, not production deployment.
USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends systemd systemd-sysv dbus \
  && apt-get clean
COPY scripts/linux-lab-service.ts /app/scripts/linux-lab-service.ts
COPY deploy/linux/wecom-agent-gateway-lab.service /etc/systemd/system/wecom-agent-gateway-lab.service
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
