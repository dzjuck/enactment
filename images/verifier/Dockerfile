# Verifier image. Runs offline with no provider CLI and no credentials: there is
# deliberately nothing here that could reach a model.
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
WORKDIR /workspace
