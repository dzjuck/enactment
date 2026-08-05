# Reviewer image. Runs one offline Semgrep CE scan over the changed files of a step: no
# provider CLI, no credential, no project dependency, no network. The rules are vendored
# here rather than downloaded, so `reviewer_image_id` is what an approval covers.
ARG SEMGREP_IMAGE
FROM ${SEMGREP_IMAGE}

ARG AGENT_UID
ARG AGENT_GID

COPY rules /opt/ai-harness/rules

# Never phone home: the container has no network, so an update or metrics attempt would hang
# rather than fail. The flags in REVIEW_ARGS are the enforcement; these are belt and braces.
ENV HOME=/home/agent \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0

# The base image ships its own entrypoint; the harness runs fixed argument arrays (§16).
ENTRYPOINT []

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /review
