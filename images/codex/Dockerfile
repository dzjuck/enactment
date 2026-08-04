# Codex image. BASE_IMAGE has no default so src/config/pins.ts stays the only pin source.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG CODEX_VERSION
ARG AGENT_UID
ARG AGENT_GID

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

# A volume mounted over a missing path is root-owned. Creating CODEX_HOME here gives the
# per-run volume uid/gid 1001 and mode 0700 so Codex can rewrite rotated credentials.
RUN mkdir -p /run/agent-auth \
 && chown "${AGENT_UID}:${AGENT_GID}" /run/agent-auth \
 && chmod 0700 /run/agent-auth

ENV CODEX_DISABLE_UPDATE_CHECK=1 \
    DO_NOT_TRACK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

ENTRYPOINT []

USER agent
WORKDIR /workspace
