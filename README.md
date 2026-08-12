# Enactment

Enactment turns an approved software-development plan into verified Git commits. Coding agents do
the work in hardened containers. No step lands until fixed gates accept it.

## The problem

Coding agents are effective at individual tasks. A multi-step plan adds a different problem: safe
progression. Each step must start from the accepted result of the previous step, stay within scope,
pass independent checks, and leave enough evidence to audit or recover it.

Interactive sessions leave much of that coordination to a person. Enactment makes it part of the
execution system.

## What Enactment does

You approve the plan once. Enactment then implements every step without you. It gives you one
branch to review at the end.

It can run without you because each step must pass fixed gates. For a code-behavior step:

- the new test fails first, for the declared reason;
- the harness freezes the test;
- the new code makes the test pass;
- the change touches only the declared files;
- a scanner finds no new blocking defect.

A retryable failure can get one controlled retry. If a gate still fails, the plan stops. Enactment
does not continue and hope.

Enactment is not an agent. It supervises agents. Codex CLI and Claude Code are interchangeable
engines inside it.

## How a plan runs

Enactment runs the steps in the written order. Each step starts at the commit that the step before
it made. Code-behavior steps must support a test-first red/green cycle. Operational `task` steps do
not require TDD. A code-behavior step follows this path:

![Plan execution flow](docs/plan-flow.svg)

The agents only write tests and implementation. Enactment owns every gate, the plan branch, and the
commits. Any failed gate stops the plan with evidence. A `task` step skips the test-specific path.
An eligible failure gets one policy-controlled retry.

## Example

<!-- TODO: a plan file, the branch it produces, a commit with its trailers, the artifact tree. -->

## Compared to an interactive coding agent

| | Interactive agent | Enactment |
| --- | --- | --- |
| Execution unit | one task or session | an approved, ordered plan |
| Progression | decided during the session | decided by fixed gates |
| Durable state | working tree and session history | SQLite, artifacts, and Git commits |
| Human role | directs or reviews the session | approves the plan, then reviews the branch |
| Output | proposed changes | verified commits on a dedicated branch |

Enactment runs Claude Code and Codex CLI inside it. It cannot ask you during a run, so it proves
the result instead. It comes back to you only when it stops: a new dependency, a new documentation
source, a disputed test contract, or a failure that survived the retry. Each one needs a new plan
revision.

## Status

**Use Enactment only on repositories you trust.**

Version 0.1.0. Everything on this page works today.

Enactment runs Node.js projects. It needs Docker or OrbStack on one host, and it runs one plan at a
time on that machine.

Not supported: untrusted repositories, Kubernetes, parallel agents, remote workers, automatic
merge, live external API calls.

## How it works

**Isolation.** Each phase runs in a disposable container. The container has no host home, no
canonical Git, no Docker socket, and no added capabilities. It runs as a non-root user with a
read-only root filesystem. Docker is the security boundary.

**Network.** A CONNECT proxy allows exact hostnames only. The verifier and the reviewer run
offline. Each phase gets its own network, which the harness destroys afterwards.

**Tests first.** The agent writes the tests. The harness proves that they fail for the declared
reason. It then freezes the tests and the runner configuration. A second agent writes the code.

**Scope.** Each step declares which files it may change. The harness rejects any change outside
that scope. Agents cannot change dependencies.

**Verification.** Tests run again in a fresh offline container with clean dependencies. Commands
are fixed argument arrays. The harness never runs a shell string that a model produced.

**Runtime check.** A step can start its application in a private offline network and check its
behavior over HTTP.

**Review.** A pinned Semgrep scan compares the changed files before and after. Only new findings
count. Critical findings always block. Warnings block high-risk steps.

**Git.** The harness owns Git. It commits to `enactment/<plan-id>`, with hooks disabled and an
expected old value on the ref. Commits carry `Enactment-Plan`, `Enactment-Step`,
`Enactment-Attempt` and `Enactment-Idempotency-Key` trailers. It never merges and never pushes.

**Recovery.** SQLite holds the plan state. After a crash, the harness reconciles the database, the
branch, the commit trailers and the artifacts. A commit that exists but was not recorded completes
without a rerun.

**Routing.** Each step declares its complexity. Low goes to Codex at medium effort. Medium goes to
Claude Sonnet at medium effort. High goes to Codex at high effort. One failure gets one diagnosis
and one stronger retry, both on Claude Opus at high effort. These routes are harness policy, not
settings: a plan cannot change the provider, the model or the effort. To change them, edit the
source and rebuild. That changes the approval hash, so every manifest needs a new approval.

**Evidence.** Every attempt writes artifacts: prompts, redacted events, container logs, proxy
records, and the results of `baseline`, `tests`, `red`, `implementation`, `green`, `verify`,
`runtime` and `review`.

## Try it

You need Docker or OrbStack, Node.js 22.13 or later, and a provider subscription. Run `codex login`
once. For Claude steps, run `claude setup-token` once and store the token as `RUNBOOK.md` describes.

```sh
npm ci
npm run images:build
npm run build

enactment prepare plan.yml --repo /path/to/repo --output manifest.yml
enactment run manifest.yml --repo /path/to/repo
```

`prepare` writes the approval. Running the manifest is the approval.

## Documentation

- [DESIGN.md](DESIGN.md) — the design, the trust model, and the measured findings that changed each
  decision.
- [RUNBOOK.md](RUNBOOK.md) — how to declare a plan, run it, read the artifacts, and recover.

## Not in V1

No planner. No automatic merge. No web interface. No local models. No parallel steps.

The review gate is a deterministic check, not proof of security, and not a replacement for reading
the branch.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 Ilya Lavrov.

The reviewer ships third-party Semgrep rules under MIT and LGPL-3.0. See
[images/reviewer/rule-packs/THIRD_PARTY_NOTICES.md](images/reviewer/rule-packs/THIRD_PARTY_NOTICES.md).
