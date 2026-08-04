# Claude image. BASE_IMAGE and the CLI version are supplied only by src/config/pins.ts.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG CLAUDE_VERSION
ARG AGENT_UID
ARG AGENT_GID

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

# A volume mounted over a missing path is root-owned. Creating the token mount point here
# makes the attempt volume readable by the fixed uid/gid 1001 agent.
RUN mkdir -p /run/claude-auth \
 && chown "${AGENT_UID}:${AGENT_GID}" /run/claude-auth \
 && chmod 0700 /run/claude-auth

COPY --chmod=0755 claude-from-token /usr/local/bin/claude-from-token

ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_BUG_COMMAND=1 \
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 \
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 \
    CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

ENTRYPOINT []

USER agent
WORKDIR /workspace
