# Setup image. The only image that reaches the package registry, and it never sees
# provider credentials.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=1

ENTRYPOINT []

USER agent
WORKDIR /workspace
