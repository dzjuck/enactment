# Egress proxy. Built from the repository root so the proxy sources can be compiled inside
# the image: no host build artifacts, and the running image contains no toolchain.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS build

ARG TYPESCRIPT_VERSION
ARG TYPES_NODE_VERSION

WORKDIR /build
COPY tsconfig.proxy.json ./tsconfig.json
COPY src/proxy ./src/proxy

RUN npm init --yes > /dev/null \
 && npm install --no-audit --no-fund --save-dev \
      "typescript@${TYPESCRIPT_VERSION}" "@types/node@${TYPES_NODE_VERSION}" \
 && npx tsc \
 && echo '{"type":"module"}' > dist/proxy/package.json

FROM ${BASE_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g agent -m -d /home/agent -s /bin/bash agent

COPY --from=build /build/dist/proxy /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    CI=1

ENTRYPOINT []

USER agent
WORKDIR /app
