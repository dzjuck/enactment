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

# CODEX_HOME. It exists in the image so that the per-run auth volume mounted here inherits
# uid/gid 1001 and mode 0700 from this directory: a volume mounted over a path the image does
# not define is created root:root 0755, which the agent cannot write, and rotation needs to
# rewrite auth.json in place. Owning it here is also what lets the harness avoid binding any
# host directory into the container, so no host uid mapping is part of the contract.
RUN mkdir -p /run/agent-auth \
 && chown "${AGENT_UID}:${AGENT_GID}" /run/agent-auth \
 && chmod 0700 /run/agent-auth

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
