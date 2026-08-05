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
* Node.js ≥ 22.13 — the harness stores plan state in `node:sqlite`, which is available
  without an opt-in flag from that release. Node prints an experimental warning for it on
  stderr; stdout stays valid JSON.
* `codex login` run once on the host. The harness reads `~/.codex/auth.json` exactly once to
  seed its own store, then never writes to your Codex home again. Once that store exists it is
  the source of truth for the refresh chain and a later `codex login` does **not** replace it —
  see "Re-authenticating".
* A Claude Pro, Max, Team or Enterprise subscription when any medium-complexity step may run.
  Run `claude setup-token` once, then store the printed token as described below. Claude Code
  subscription calls consume the plan's separate Agent SDK credit; inspect that allowance before
  enabling Claude routing.
* A Git repository to work on, committed clean. The harness works from a commit, never from
  your working tree, and never touches your checked-out branch.
* A fresh schema-version-2 `state.db`. There is intentionally no migration from earlier
  milestones. Preserve any needed evidence, then move the old database aside before the first run.

## 1. Build

```sh
npm ci
npm run images:build     # builds Codex, Claude, verifier, reviewer, setup and proxy images
npm run build            # compiles the harness into dist/
```

`images:build` is a prerequisite of every run. Startup resolves each image tag to an immutable
Docker image ID and executes that ID; if an image is missing, the run stops before any container
starts and names this command.

## 2. Declare a plan

Work is declared as a plan: an ordered step list plus the commands that verify the finished
branch. One invocation executes every step in the order they are written — step N starts at the
commit step N-1 produced — and then verifies the finished branch. The authored order *is* the
dependency chain; there is no separate `depends_on`.

For a tests-first behavior change:

```yaml
version: 1
id: slugify-plan
steps:
  - type: code_behavior
    complexity: low
    risk: standard
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
commands, reviews changed files offline, then commits both changes. Phase artifacts live under `baseline/`, `tests/`, `red/`,
`implementation/`, and `green/`.

The original single-agent step type remains available:

```yaml
version: 1
id: slugify-plan
steps:
  - type: task
    complexity: medium
    risk: high
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

`complexity` is required. Routing is fixed and covered by the policy hash:

| Complexity | Normal profile | Provider/model effort |
| --- | --- | --- |
| `low` | `codex-fast` | Codex, medium |
| `medium` | `claude-balanced` | Claude, medium |
| `high` | `codex-deep` | Codex, high |

The table is deterministic, not a ranking. No normal route uses `claude-deep`; it is reserved for
the one stronger retry, so a retry always differs from the normal profile. One profile owns every
model phase in an attempt. Plans cannot override provider, model or effort.

`risk` is required and is either `standard` or `high`. Mark authentication, authorization,
financial logic, migrations, destructive local behavior, concurrency and credential handling as
`high`. Risk changes only the review threshold: critical findings always block; warnings are
recorded for `standard` steps and block `high` steps.

`operational` and `mixed` steps are rejected until their milestone, as are service fields and
user-defined review commands, rules, suppressions or overrides.

Rules the loader enforces: no unknown fields; verification commands are argv arrays, never shell
strings; `implementation_paths` are relative, free of `..`, and may not name `package.json` or a
lockfile. `timeouts` may lower the defaults above, never raise them.

`timeouts` does not cover verification: a verification command that hangs is killed after a fixed
600 s in V1. If your suite legitimately runs longer than that, split it across commands.

## 3. Prepare and approve

Preparation resolves everything an approval covers — the plan's exact bytes, the repository's
current head, fixed network/routing/dependency/review policies, and the six runtime image IDs — into
one candidate manifest. It is read-only apart from the file it writes:

```sh
node dist/cli.js prepare plan.yml --repo /path/to/repo --output execution-manifest.yml
```

```yaml
execution_manifest:
  version: 1
  plan_file: plan.yml          # resolved relative to the manifest
  repository:
    base_branch: main
    base_commit: 0b6f...       # execution starts here, wherever the branch moves later
  inputs:
    plan_hash: sha256:...      # the plan's raw bytes: commands, scopes, closure, quarantine
    policy_hash: sha256:...    # the fixed network and dependency policies
  runtime:
    harness_version: 0.1.0
    codex_image_id: sha256:...
    claude_image_id: sha256:...
    verifier_image_id: sha256:...
    reviewer_image_id: sha256:...
    setup_image_id: sha256:...
    proxy_image_id: sha256:...
```

Read it, then run it. **Running the manifest is the approval** — there is no separate approve
command. Before anything executes, the harness recomputes every field: a changed plan, a changed
policy, a rebuilt image, a different harness version, or a base commit the repository can no
longer resolve stops the run with a named error (`plan_changed`, `policy_changed`,
`runtime_changed`, `base_unresolvable`). Re-prepare and re-read to approve the new inputs.

## 4. Run

```sh
node dist/cli.js run execution-manifest.yml --repo /path/to/repo --artifacts ./artifacts
```

One invocation executes every remaining step in plan order, without asking again. Each step
starts at the previous step's accepted commit, never at your checked-out `HEAD`. After the last
step, the plan's `final_verification.commands` run offline against the finished branch head.

Exit code 0 means the plan completed, including final verification. A run that verified the
branch but could not release its containers or volumes exits non-zero and reports those
`cleanupErrors`: the branch is good, but the run cannot account for what it left behind.

The JSON report on stdout carries the plan state, branch and head, each step's `attempts` list and
commit, final verification, and any failure. Each attempt lists `id`, `kind` (`normal` or
`stronger`), `profile`, `state`, optional commit, diagnosis, and a review summary containing risk,
verdict and severity counts. The same report is
stored under `<artifacts>/<plan-id>/reports/invocation-<n>.json`, and earlier reports are never
replaced.

Commits land on `ai-harness/<plan-id>` — one stable branch per plan, advanced linearly — with
hooks disabled and the `AI-Harness-Plan`, `AI-Harness-Step`, `AI-Harness-Attempt` and
`AI-Harness-Idempotency-Key` trailers. Nothing is merged and nothing is pushed:

```sh
git log --oneline main..ai-harness/<plan-id>
git show ai-harness/<plan-id>
```

The harness only ever advances that ref from where it last left it. A branch that already exists
when a plan has accepted nothing, or one that has been moved behind the harness's back, stops the
plan rather than being adopted or forced.

### Retry and resume

Re-run the same manifest. No new approval is needed, and what happens depends on what the
database records:

| Recorded state | What the rerun does |
| --- | --- |
| Plan completed | Returns the stored report. No agent, no verifier, no Git write, no new attempt. |
| Retryable normal attempt failed | Runs one workspace-free `claude-deep` diagnosis, then one stronger attempt from the same accepted parent. |
| Diagnosis failed or timed out | Still runs the stronger attempt; the original failure remains primary. |
| Stronger or non-retryable attempt failed | Stops. A later explicit rerun starts a new normal cycle from the last accepted commit. |
| Step committed, then teardown failed | The commit is already visible, so the step counts as accepted and the head has moved; the rerun continues with the **next** step. |
| Attempt still `running` (the process was killed) | Reuses that attempt id and reruns the whole step from its stored parent. The killed run's evidence is kept; the rerun writes to `run-2`. |
| Attempt `accepting`, commit already on the branch | Finishes the database transition only — no agent, no verifier. |
| Attempt `accepting`, no commit | Retries Git acceptance alone, from the verified snapshot, under the same idempotency key. |
| Final verification failed | Reruns only final verification. |

A commit can never be duplicated: acceptance is keyed on the manifest, plan, step, attempt and
parent commit, and a repeated key returns the existing commit instead of making a second one.

One invocation can make at most one normal attempt, one diagnosis and one stronger attempt.
`provider_error` is deliberately non-retryable: it is a provider refusal such as invalid auth,
quota or an unavailable model, not evidence that a stronger model can repair the workspace.
`review_blocked` is retryable; `review_failed` is not. A blocked implementation may be repaired by
the stronger attempt. A scanner timeout, error or invalid result requires fixing the reviewer.

### Cancelling

```sh
node dist/cli.js cancel execution-manifest.yml --repo /path/to/repo --artifacts ./artifacts
```

One live plan may own a repository at a time; cancelling releases it so a different manifest can
register. The branch, its commits, the attempt history and the evidence all survive, because they
are evidence of work that really happened. The one thing it deletes is the plan's `snapshots/`
directory: retiring the plan is the last moment anything comes back for the workspace tars a
killed run left, and their hashes stay in the evidence. Pass the same `--artifacts` you ran with
so it can find them. It is idempotent, a no-op on an already completed plan, and it refuses a
repository the given manifest does not own.

**Cancellation is terminal.** Running the cancelled manifest again returns a `cancelled` report
and a non-zero exit without reconciling, running a step, or verifying anything. To carry the work
further, prepare and approve a new manifest — that is what cancelling freed the repository for.

Optional environment (state locations only; nothing here reaches the container contract):

| Variable | Meaning |
| --- | --- |
| `HARNESS_STATE_DIR` | Harness state root. Default `~/.local/state/ai-harness`. Holds `state.db`. |
| `HARNESS_STORE_DIR` | Credential store directory. |
| `HARNESS_DEPS_DIR` | Dependency cache directory. |
| `HARNESS_SOURCE_CODEX_HOME` | Where the store is seeded from. Default `~/.codex`. |

## 5. Read the artifacts

Everything a plan produces lives under `<artifacts>/<plan-id>/`:

```text
<artifacts>/<plan-id>/
  execution-manifest.yml          the approval this run executed under
  plan.yml                        the exact plan bytes it was approved for
  reports/invocation-<n>.json     one per state-changing invocation, never replaced
  steps/<step-id>/<attempt>/run-<n>/
    diagnosis/                    evidence-only diagnosis for a failed normal attempt
  final/run-<n>/final-verification.json
  snapshots/                      see retention below
```

Inside one `run-<n>` directory:

| File | What it holds |
| --- | --- |
| `run-manifest.json` | Base commit, input hashes, six executed image IDs, selected profile, requested/reported model, usage, review verdict, snapshots, result and cleanup errors. |
| `prompt.txt` | Exactly what the agent was sent. |
| `agent-events.jsonl` / `claude-events.jsonl` | Redacted provider event stream. |
| `logs/agent.log`, `logs/verification.log` | Redacted container output. |
| `proxy-records.jsonl` | One record per connection: hostname, allowed/denied, bytes, duration, result. |
| `verification.json` | Per-command exit codes and output. |
| `source-diff.json` | The validated change set that was committed. |
| `review/scan.json` | Reduced before/after findings; no scanner messages or source. |
| `review/review.json` | Introduced findings, risk, verdict, counts, reviewer image and scanned paths. |
| `review/reviewer.log` | Redacted scanner stderr. |
| `diagnosis/diagnosis.json` | Redacted status and advisory text for a retryable failed normal attempt. |

A `code_behavior` step adds `baseline/`, `tests/`, `red/`, `implementation/` and `green/`
beneath its run directory.

Credentials are redacted at the artifact boundary; the artifact tree should never contain a
token. The manifest's `*_image_id` fields are the images that actually ran.

**Snapshots are not kept.** While an attempt runs, every workspace tar it takes stays in
`snapshots/`, because the verifier reads them during baseline, RED and GREEN. When the attempt
terminates they are deleted — except one still needed as the verified acceptance candidate of an
attempt interrupted mid-commit, which goes once its commit is recorded. What a killed process left
behind goes at the start of the next run of that plan, or when the plan is cancelled. Their hashes
remain in `run-manifest.json` either way, so a run stays reproducible without storing every tree
forever.

Persistent state lives outside the artifact directory, under `HARNESS_STATE_DIR`: `auth/` (the
credential store, mode `0600`), `dependency-cache/`, and `state.db`.

### The plan database

`${HARNESS_STATE_DIR}/state.db` records plans, steps and attempts, with foreign keys and WAL
enabled. It is what makes a rerun resume rather than restart. Git remains authoritative for
whether an acceptance became externally visible; the database is reconciled against it at the
start of every run.

```sh
sqlite3 "${HARNESS_STATE_DIR:-$HOME/.local/state/ai-harness}/state.db" \
  'select plan_id, state, head_commit from plans;'
```

Node prints an experimental warning for `node:sqlite` on stderr. It is expected; stdout stays
valid JSON.

## 6. Re-authenticating

### Codex

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

### Claude

Claude auth is a private static token file, not the Codex store. Provision it once:

```sh
claude setup-token
install -d -m 0700 "${HARNESS_STATE_DIR:-$HOME/.local/state/ai-harness}/auth/claude"
chmod 0700 "${HARNESS_STATE_DIR:-$HOME/.local/state/ai-harness}/auth/claude"
umask 077
read -r -s CLAUDE_SETUP_TOKEN
printf '%s\n' "$CLAUDE_SETUP_TOKEN" > \
  "${HARNESS_STATE_DIR:-$HOME/.local/state/ai-harness}/auth/claude/token"
unset CLAUDE_SETUP_TOKEN
```

The harness reads that file, streams it into an attempt-scoped volume, and never rotates it or
copies it into Docker metadata. Re-authenticate by replacing only this file with a new
`claude setup-token` value and mode `0600`; Codex auth remains untouched. Do not pass the token as
a command argument or Docker environment variable.

## 7. Recovery

A run that ends normally — success or failure — releases everything it created. A process killed
outright (SIGKILL, a crash) cannot, and leaves labelled resources behind:

```sh
docker ps -a --filter label=ai-harness.attempt
docker volume ls --filter label=ai-harness.attempt
docker network ls --filter label=ai-harness.attempt
```

The next `run` removes all of them at startup, before it validates the manifest or opens the
database. No manual cleanup step is required; just start the next run. If startup cannot reach an
empty state it refuses to run and names what survived.

After the sweep, the harness reconciles the database against Git before selecting any work, and
then resumes as described in "Retry and resume" above. A disagreement it cannot explain — a plan
branch that no longer matches the recorded head, a commit carrying an attempt's key on the wrong
parent — stops the plan without changing either side.

## 8. When something fails

| Symptom | Meaning |
| --- | --- |
| `runtime image ... is not available locally` | Run `npm run images:build`. |
| `provider_connectivity_timeout` | The provider was unreachable through the proxy allowlist. Nothing was spent on the agent phase. |
| `setup_timeout` / `setup_failed` | The dependency install overran its budget or failed. No cache entry is published. |
| `agent_timeout` / `agent_failed` | The agent was killed at its deadline or exited non-zero. The attempt workspace is discarded; no commit. |
| `provider_error` | The provider refused the request. It is recorded from structured provider output and is not diagnosed or retried; check auth, plan/Agent SDK credit and pinned model availability. |
| `invalid_change` | The agent wrote outside `implementation_paths`, touched a dependency manifest, added an unsafe symlink, or changed nothing. |
| `baseline_failed` | Existing tests failed, an expected test already existed, or baseline retry policy blocked the run. |
| `red_invalid` | New tests did not fail for an allowed, behavior-related reason. Read `red/verdict.json`. |
| `closure_violation` | An agent changed a frozen test, runner configuration, setup file, manifest, or lockfile. |
| `test_contract_disputed` | The implementation agent reported that the frozen tests are wrong. Read `implementation/test-contract-dispute.md`; no commit was created. |
| `verification_failed` | GREEN or an opaque verification command failed. Read `green/verdict.json` and `verification.json`. |
| `review_blocked` | A critical finding, or any warning on a high-risk step. Read `review/review.json`; one stronger retry is allowed. |
| `review_failed` | The scanner timed out, exited non-zero, reported an error, or returned invalid JSON. Terminal; repair the reviewer instead of rerolling code. |
| Report `failed` with a `commit` and a copy-back cleanup error | The work was verified and committed, but the rotated credential could not be saved. Re-authenticate (§6) before the next run. |
| `plan_changed` / `policy_changed` / `runtime_changed` | The approval no longer describes what would run: the plan bytes, the fixed policies, or the harness version and image IDs changed. Re-prepare, read the new manifest, and run it. |
| `base_unresolvable` | The approved base commit does not exist in this repository. Wrong `--repo`, or the commit was garbage-collected. |
| `already exists but this plan has accepted nothing` | `ai-harness/<plan-id>` exists from an earlier plan or a person. Rename or delete it, or choose a different plan id. |
| `refusing to move a ref the harness no longer recognises` | The plan branch and the recorded head disagree. Nothing was changed; reconcile by hand, or cancel the plan and start a new one. |
| `is owned by plan ... cancel it before registering a different manifest` | Another plan owns this repository. Finish it, or `cancel` its manifest. |

Review is one pinned Semgrep CE scan over added and modified files, offline and without credentials,
dependencies or canonical Git. Findings already present in the parent are subtracted. A rename is
treated as an addition, so moved vulnerable legacy code can block. CE analysis is intra-file: this
is a narrow deterministic gate, not proof of security or a replacement for human branch review.

There is no waiver. Resolve a false-positive critical finding by changing the code, or change the
vendored rules/reviewer image and re-prepare for explicit approval. Rule, scanner, policy or image
changes always require rebuild plus re-approval.
