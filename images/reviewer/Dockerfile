# Reviewer image. Runs one offline Semgrep CE scan over the changed files of a step: no
# provider CLI, no credential, no project dependency, no network. The rules are vendored
# here rather than downloaded, so `reviewer_image_id` is what an approval covers.
ARG SEMGREP_IMAGE
FROM ${SEMGREP_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

COPY rules /opt/enactment/rules

# Semgrep writes a settings file and a log under $HOME. The base image has no agent home, and
# a tmpfs or volume takes its ownership from the image's mount point, so the directory has to
# exist here with the numeric identity the container runs as.
RUN mkdir -p /home/agent \
 && chown "${AGENT_UID}:${AGENT_GID}" /home/agent \
 && chmod 0700 /home/agent

# Never phone home: the container has no network, so an update or metrics attempt would hang
# rather than fail. The flags in REVIEW_ARGS are the enforcement; these are belt and braces.
ENV HOME=/home/agent \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0

# The base image ships its own entrypoint; the harness runs fixed argument arrays (§16).
ENTRYPOINT []

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /review
