# V1 Runbook

The supported operator path: build the images, run one plan, read the artifacts, recover from a
crash. Nothing here uses the test suites.

## Support scope

* Docker or OrbStack on the **current platform only**. Images are built locally from pinned
  Dockerfiles; cross-platform reproducibility and native-Linux certification are deferred.
* **One production run at a time.** Startup cleanup removes every harness-labelled resource
  (§5 of `DESIGN.md`), so a second concurrent run would delete the first one's containers.

## Prerequisites

* Docker or OrbStack running (`docker version` must report a server).
* Node.js ≥ 22.
* `codex login` run once on the host. The harness reads `~/.codex/auth.json` exactly once to
  seed its own store, then never writes to your Codex home again. Once that store exists it is
  the source of truth for the refresh chain and a later `codex login` does **not** replace it —
  see "Re-authenticating".
* A Git repository to work on, committed clean. The harness works from a commit, never from
  your working tree, and never touches your checked-out branch.

## 1. Build

```sh
npm ci
npm run images:build     # builds agent, verifier, setup, proxy; prints the resolved image IDs
npm run build            # compiles the harness into dist/
```

`images:build` is a prerequisite of every run. Startup resolves each image tag to an immutable
Docker image ID and executes that ID; if an image is missing, the run stops before any container
starts and names this command.

## 2. Declare a plan

Work is declared as a plan: an ordered step list plus the commands that verify the finished
branch. This build executes plans of exactly one step; a longer plan is rejected rather than
truncated.

For a tests-first behavior change:

```yaml
version: 1
id: slugify-plan
steps:
  - type: code_behavior
    id: add-slugify
    observable_behavior: Add URL-safe slugify behavior.
    implementation_paths:
      - src/slugify.js
    test_paths:
      - test/slugify.test.js
    expected_test_ids:
      - slugify lowercases and hyphenates words
    allowed_red_categories:
      - assertion_failure
      - missing_implementation
    verification:
      test_command: ["npx", "--no-install", "vitest", "run", "--globals"]
final_verification:
  commands:
    - ["npx", "--no-install", "vitest", "run", "--globals"]
```

`observable_behavior` is the text sent to the agent. Plan and step IDs are lowercase slugs,
because they name a Git branch and an artifact directory. `final_verification.commands` is
required; it runs against the finished branch.

`test_command` is the verification. `commands` is optional here and is for anything the test run
does not cover — a type check, a linter — not a repeat of the suite.

`expected_test_ids` uses Vitest's full test name: ancestor `describe` titles followed by the `it`
title. For `describe('slugify')` and `it('lowercases and hyphenates words')`, declare
`slugify lowercases and hyphenates words` exactly.

The harness captures the baseline, asks one agent to write tests, verifies RED, freezes tests and
runner inputs, asks a second agent for implementation, verifies GREEN offline, runs the opaque
commands, then commits both changes. Phase artifacts live under `baseline/`, `tests/`, `red/`,
`implementation/`, and `green/`.

The original single-agent step type remains available:

```yaml
version: 1
id: slugify-plan
steps:
  - type: task
    id: add-slugify
    observable_behavior: |
      Implement the slugify function in src/slugify.js.
    implementation_paths:
      - src/slugify.js
    verification:
      commands:
        - ["npx", "--no-install", "vitest", "run"]
    timeouts:
      connectivity_smoke_seconds: 60
      setup_seconds: 600
      agent_seconds: 1200
      termination_grace_seconds: 10
final_verification:
  commands:
    - ["npx", "--no-install", "vitest", "run"]
```

`operational` and `mixed` steps are rejected until their milestone, as are service, routing and
review fields.

Rules the loader enforces: no unknown fields; verification commands are argv arrays, never shell
strings; `implementation_paths` are relative, free of `..`, and may not name `package.json` or a
lockfile. `timeouts` may lower the defaults above, never raise them.

`timeouts` does not cover verification: a verification command that hangs is killed after a fixed
600 s in V1. If your suite legitimately runs longer than that, split it across commands.

## 3. Run

```sh
node dist/cli.js run plan.yml --repo /path/to/repo --artifacts ./artifacts
```

Exit code 0 means verified and committed. The report is printed as JSON on stdout, and the same
outcome is recorded under `result` in `run-manifest.json`.

The commit is made on a harness-owned branch `ai-harness/<task-id>-<attempt>`, with hooks
disabled and the `AI-Harness-Task`, `AI-Harness-Attempt` and `AI-Harness-Idempotency-Key`
trailers. Nothing is merged and nothing is pushed — review the branch yourself.

Optional environment (state locations only; nothing here reaches the container contract):

| Variable | Meaning |
| --- | --- |
| `HARNESS_STATE_DIR` | Harness state root. Default `~/.local/state/ai-harness`. |
| `HARNESS_STORE_DIR` | Credential store directory. |
| `HARNESS_DEPS_DIR` | Dependency cache directory. |
| `HARNESS_SOURCE_CODEX_HOME` | Where the store is seeded from. Default `~/.codex`. |

## 4. Read the artifacts

In `--artifacts`:

| File | What it holds |
| --- | --- |
| `run-manifest.json` | Base branch and commit, input hashes, the four executed image IDs, snapshot hashes, usage, result, cleanup errors. |
| `prompt.txt` | Exactly what the agent was sent. |
| `agent-events.jsonl` | Redacted agent event stream. |
| `logs/agent.log`, `logs/verification.log` | Redacted container output. |
| `proxy-records.jsonl` | One record per connection: hostname, allowed/denied, bytes, duration, result. |
| `verification.json` | Per-command exit codes and output. |
| `source-diff.json` | The validated change set that was committed. |
| `snapshots/` | Content-addressed workspace snapshots. |

Credentials are redacted at the artifact boundary; the artifact tree should never contain a
token. The manifest's `*_image_id` fields are the images that actually ran.

Persistent state lives outside the artifact directory, under `HARNESS_STATE_DIR`: `auth/` (the
credential store, mode `0600`) and `dependency-cache/`.

## 5. Re-authenticating

The harness store, once seeded, is deliberately never re-seeded: Codex rotates the refresh token
in place, so overwriting the store from a stale `~/.codex/auth.json` would hand back a spent
token. The consequence is that `codex login` alone does not give the harness a new credential —
the store has to be removed first, so the next run seeds it again:

```sh
codex login
rm -f "${HARNESS_STORE_DIR:-${HARNESS_STATE_DIR:-$HOME/.local/state/ai-harness}/auth}/auth.json"
```

The next run re-seeds the store from `~/.codex/auth.json`. Do this after any failure that says
the credential could not be read, parsed, or saved.

## 6. Recovery

A run that ends normally — success or failure — releases everything it created. A process killed
outright (SIGKILL, a crash) cannot, and leaves labelled resources behind:

```sh
docker ps -a --filter label=ai-harness.attempt
docker volume ls --filter label=ai-harness.attempt
docker network ls --filter label=ai-harness.attempt
```

The next production run removes all of them at startup, before creating its attempt. No manual
cleanup step is required; just start the next run. If startup cannot reach an empty state it
refuses to run and names what survived.

## 7. When something fails

| Symptom | Meaning |
| --- | --- |
| `runtime image ... is not available locally` | Run `npm run images:build`. |
| `provider_connectivity_timeout` | The provider was unreachable through the proxy allowlist. Nothing was spent on the agent phase. |
| `setup_timeout` / `setup_failed` | The dependency install overran its budget or failed. No cache entry is published. |
| `agent_timeout` / `agent_failed` | The agent was killed at its deadline or exited non-zero. The attempt workspace is discarded; no commit. |
| `invalid_change` | The agent wrote outside `implementation_paths`, touched a dependency manifest, added an unsafe symlink, or changed nothing. |
| `baseline_failed` | Existing tests failed, an expected test already existed, or baseline retry policy blocked the run. |
| `red_invalid` | New tests did not fail for an allowed, behavior-related reason. Read `red/verdict.json`. |
| `closure_violation` | An agent changed a frozen test, runner configuration, setup file, manifest, or lockfile. |
| `test_contract_disputed` | The implementation agent reported that the frozen tests are wrong. Read `implementation/test-contract-dispute.md`; no commit was created. |
| `verification_failed` | GREEN or an opaque verification command failed. Read `green/verdict.json` and `verification.json`. |
| Report `failed` with a `commit` and a copy-back cleanup error | The work was verified and committed, but the rotated credential could not be saved. Re-authenticate (§5) before the next run. |
