# Egress proxy runtime. The CONNECT proxy itself arrives in Step 11; this image is the
# hardened Node runtime it will run under.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

ENTRYPOINT []

USER agent
WORKDIR /app
