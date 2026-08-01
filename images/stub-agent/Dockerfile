# Test double for the agent image: identical shape, no provider CLI, no network use.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

COPY codex /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex

ENV CI=1

ENTRYPOINT []

USER agent
WORKDIR /workspace
