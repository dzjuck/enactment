ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent \
 && mkdir -p /run/agent-auth /run/claude-auth \
 && chown "${AGENT_UID}:${AGENT_GID}" /run/agent-auth /run/claude-auth \
 && chmod 0700 /run/agent-auth /run/claude-auth

COPY demo/answers/ /answers/
COPY demo/agent/codex /usr/local/bin/codex
COPY demo/agent/claude /usr/local/bin/claude
COPY images/stub-agent/claude-from-token /usr/local/bin/claude-from-token
RUN chmod 0755 /usr/local/bin/codex /usr/local/bin/claude /usr/local/bin/claude-from-token

ENV CI=1

ENTRYPOINT []

USER agent
WORKDIR /workspace
