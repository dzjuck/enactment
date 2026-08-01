# Agent image. The only image that carries the provider CLI.
# BASE_IMAGE has no default on purpose: src/config/pins.ts is the single source of the pin,
# and an unpinned build must fail rather than silently float.
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

# DESIGN.md §27 gate 13: no auto-update, no telemetry. The generated config.toml
# carries the rest of the policy.
ENV CODEX_DISABLE_UPDATE_CHECK=1 \
    DO_NOT_TRACK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

# The harness passes fixed argv arrays (§16); nothing may wrap them.
ENTRYPOINT []

USER agent
WORKDIR /workspace
