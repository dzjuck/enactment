# Universal AI Plan-Implementation Harness

## Final Docker-Based V1 Design

## 1. Goal

Turn an approved implementation plan into autonomous, verified Git commits.

```text
Trusted repository
→ plan
→ one approval
→ isolated execution
→ deterministic verification
→ automatic progression
→ reviewable branch
```

The harness provides:

* executable plans;
* tests-first execution;
* strict change scopes;
* independent verification;
* plan amendment;
* model routing;
* targeted human review;
* persistent state;
* harness-owned Git.

Codex CLI and Claude Code provide AI reasoning and implementation.

---

## 2. V1 scope

Supported:

* trusted repositories;
* local Docker or OrbStack;
* macOS and Linux;
* Node.js projects initially;
* Codex CLI;
* Claude Code;
* one active plan per repository;
* one step at a time.

Not supported:

* untrusted repositories;
* Kubernetes;
* Docker-in-Docker;
* agent Docker access;
* parallel agents;
* concurrent harness runs (see §5, startup cleanup);
* remote workers;
* production deployment;
* live external API verification;
* external writes;
* automatic merge;
* local service containers;
* OpenHands;
* Web UI;
* local models.

Unsupported requirements stop explicitly.

---

## 3. Architecture

```text
Host
├── TypeScript harness
├── canonical Git repository
├── SQLite
├── artifacts
├── Docker daemon
└── disposable containers
    ├── agent
    ├── verifier
    ├── setup
    ├── reviewer
    ├── documentation downloader
    └── egress proxy
```

Docker is the host-isolation boundary.

Provider-native sandboxes are not required in V1.

Provider configuration only controls:

* model and effort;
* enabled tools;
* web-search disablement;
* MCP disablement;
* non-interactive mode;
* structured output.

---

## 4. Trust model

### Host isolation

Agent containers receive no access to:

* host home;
* canonical `.git`;
* other repositories;
* SSH files;
* cloud credentials;
* Docker socket;
* host devices;
* production data.

Containers run:

* non-root;
* unprivileged;
* read-only root filesystem;
* no added capabilities;
* `no-new-privileges`;
* CPU, memory and PID limits.

### Cloud-model access

Supported values:

```yaml
cloud_model_access: allowed
```

```yaml
cloud_model_access: prohibited
```

`prohibited` means V1 cannot execute the repository.

V1 does not promise path-level confidentiality.

### Provider authentication

V1 authentication mode:

```yaml
authentication:
  mode: agent_readable_subscription
```

The agent can potentially read its own provider credential.

This is an accepted V1 risk.

Use only with:

* trusted repositories;
* trusted prompts;
* no untrusted execution-time content.

Credential scanning is diagnostic only, not prevention.

A credential broker is future work.

---

## 5. Container hardening

Default agent container:

```yaml
container:
  user: "1001:1001"
  privileged: false
  root_filesystem: read_only
  no_new_privileges: true
  capabilities: []
  docker_socket: false
  host_network: false

  limits:
    # Exceeds the 8 GB OrbStack VM, so on that host it is a nominal limit rather than a
    # real one. Applied as declared; revisit when the VM is sized independently.
    memory_mb: 8192
    cpus: 4
    pids: 512

  environment:
    HOME: /home/agent

  tmpfs:
    - /tmp:rw,nosuid,nodev,mode=1777
    - /home/agent:rw,nosuid,nodev,uid=1001,gid=1001,mode=0700
```

### Writable home tmpfs

Numeric ownership is mandatory, not decorative.

Docker special-cases `/tmp` to mode `1777`. Every other tmpfs target is created
`0755 root:root`, which a non-root agent cannot write. A tmpfs `/home/agent` declared without
`uid`/`gid` therefore produces a container that starts normally and then fails on the first write
to the agent's own home directory.

The image must define the agent user with fixed UID and GID `1001`, so that the numeric
ownership above and the numeric `user` match.

`HOME` must be set explicitly to `/home/agent`.

Mounted:

```text
/workspace        writable Docker volume
/context          read-only context
/run/agent-auth   writable Docker volume, provider authentication
```

`/run/agent-auth` is read-write because the provider CLI persists rotated credentials there.

It is an **attempt-scoped Docker volume, never a bind mount of the harness auth store.** A bind
mount carries host ownership into the container: on OrbStack and Docker Desktop the runtime
remaps it and the problem is invisible, but on native Linux a mode-`0600` file owned by the
invoking user is unreadable to uid 1001, and the only fix would be to `chown` the user's own
credentials. A volume removes host uid mapping from the container contract entirely.

The volume inherits `1001:1001` and mode `0700` from `/run/agent-auth` in the agent image, which
is why that directory exists at build time. Seeding and read-back go through offline helper
containers running as the agent user; the credential travels on stdin, never in an argv or an
environment value where `docker inspect` would retain it. The volume is destroyed with the
attempt, and the rotated credential is copied back to the host store before it goes.

Copy-back is fail-safe: only a credential that reads back and parses as JSON may replace the
host store, which is the persistent source of truth. A missing, unreadable, empty or malformed
run credential fails the run and leaves the previous credential intact — it is never renamed
over. Because copy-back happens in teardown, such a failure can follow a verified, committed
run; the failed report carries both facts, the commit and the copy-back error.

Verifier, reviewer and setup containers receive no provider authentication.

### Execution timeouts

The provider CLI does not terminate quickly when provider access fails. It retries and reconnects
indefinitely. A misconfigured network therefore produces a hang, not an error, and no phase may
rely on the agent exiting by itself.

Every invocation declares:

```yaml
timeouts:
  connectivity_smoke_seconds: 60
  setup_seconds: 600
  agent_seconds: 1200
  termination_grace_seconds: 10
```

On timeout:

```text
SIGTERM
→ wait termination_grace_seconds
→ SIGKILL container
→ dispose of the attempt workspace
→ classify failure
```

**A failed attempt's workspace is disposable.** Every failure that can leave it half-written — a
killed agent, one that exited non-zero, an unparseable event stream, a change that fails scope,
dependency-manifest or symlink validation — deletes the workspace volume with the rest of the
attempt. Nothing downstream ever reads it again, so nothing restores it first: restoring a volume
in order to delete it produces a claim, not a safety property, and a manifest that reports a
restoration nobody needed is worse than one that reports none.

The pre-agent snapshot is still taken and recorded. It is evidence — the exact workspace the
agent was handed, so a run can be reproduced — not a rollback point.

Verifier failure changes nothing here either. Verification runs against a disposable copy of the
implementation snapshot, so the agent workspace was never touched; the copy is simply removed.

### Startup cleanup

Every attempt-scoped container, volume and network carries the harness label. Ordinary teardown
is owned by the module that created the resource and is scoped to one attempt; the label exists
for what teardown cannot reach — a process killed outright, whose attempt id dies with it.

The production CLI therefore sweeps **every** harness-labelled resource at startup, before it
creates a new attempt, in the order containers → volumes → networks, and refuses to run if it
cannot reach an empty state. That sweep owns all of them, which is why V1 does not support two
production runs at once. Running a task programmatically stays attempt-scoped and never sweeps
globally, which is what lets the test suites run in parallel.

Failure category:

```text
provider_connectivity_timeout
```

The shorter connectivity smoke-test timeout exists so that an unreachable provider is reported in
under a minute rather than after the full agent budget.

`setup_seconds` bounds the cold dependency install, which is the other phase that reaches the
network and can therefore hang rather than fail. It uses the same ladder and is classified
`setup_timeout`, kept distinct from `setup_failed`: a budget overrun and a package manager
reporting a real error call for different responses. A warm dependency cache never reaches it.

A task may lower any of these; it may never raise them.

---

## 6. Phase-specific networks

Never place all phases on one shared egress-capable network.

### Agent phase

```text
agent
└── agent-egress-net
    └── provider proxy
```

### Offline verifier

```text
network_mode: none
```

### Local runtime check

```text
application ── attempt-runtime-net ── behavioral-check verifier
```

The runtime network is internal. Neither container can reach the provider proxy or the internet.

### Setup phase

```text
setup container
└── registry-egress-net
```

### Documentation phase

```text
downloader
└── documentation-egress-net
```

Every topology is created per phase and destroyed afterward.

---

## 7. Egress proxy

Use a CONNECT-level exact-hostname allowlist.

Matching is exact. A hostname is allowed only if it appears in the list verbatim. No substring
matching, no implicit subdomains, no wildcards.

Record:

* hostname;
* allowed or denied;
* bytes transferred;
* duration;
* connection result.

### The proxy remains permanently L4

Do not terminate TLS.

Codex communicates over a WebSocket:

```text
wss://chatgpt.com/backend-api/codex/responses
```

After the upgrade there is no request/response structure left to inspect, so TLS interception
would buy nothing even if it were acceptable. This makes the decision permanent rather than
provisional.

Never add:

* TLS interception;
* CA injection;
* HTTP method inspection;
* path inspection;
* response inspection.

Therefore V1 cannot inspect:

* HTTP method;
* path;
* body;
* response status.

### Codex allowlist

For the tested combination:

```yaml
codex_cli: 0.146.0
authentication: existing ChatGPT subscription
transport: WebSocket
```

Codex works with only:

```yaml
allowed_hosts:
  - chatgpt.com
```

Deny `ab.chatgpt.com` and every other host.

This allowlist is version-specific. Re-run domain discovery whenever:

* the Codex version changes;
* the authentication mode changes;
* the image changes.

### Network policy suppresses telemetry

Do not claim telemetry is disabled by configuration.

The correct statement is:

```text
Nonessential provider traffic is blocked by the exact-host egress allowlist.
```

Measured: `ab.chatgpt.com` attempted roughly 382 KB of traffic. The proxy denied it and normal
execution continued unaffected.

Provider configuration may request telemetry disablement, and auto-update is disabled where the
provider supports it, but the proxy is the enforcement layer.

---

## 8. Post-V1 external verification constraints

V1 does not perform live external API verification.

CONNECT allowlisting cannot enforce read-only HTTP behavior.

Any future live verification is permitted only for:

1. public unauthenticated APIs where writes are unavailable;
2. credentials with server-enforced read-only permissions;
3. in-process mocks or recorded fixtures.

Generic authenticated API access is not read-only.

V1 does not perform:

* POST mutations;
* DELETE operations;
* remote migrations;
* deployments;
* production writes.

---

## 9. Workspace storage

Source lives in a Docker named volume, not a host bind mount.

Benefits:

* better macOS performance;
* Linux-consistent filenames;
* no APFS case or Unicode mismatch;
* container-side manifest calculation.

Initial flow:

```text
canonical commit
→ tar export
→ workspace volume
→ synthetic Git initialization
```

---

## 10. Synthetic Git

The agent receives a disposable Git repository:

```bash
git init
git add .
git -c core.hooksPath=/dev/null commit \
  -m "Synthetic workspace baseline"
```

This supports:

* `git describe`;
* Nx/Turbo affected detection;
* Jest changed-file modes;
* Changesets;
* repository scripts expecting Git.

The agent never sees canonical history, refs, remotes or credentials.

Synthetic Git is discarded after the attempt.

---

## 11. Workspace snapshots

Before every agent invocation:

```text
workspace volume
→ tar snapshot
→ immutable artifact
```

A snapshot is an immutable record and, where a later phase needs the same tree, the thing it is
seeded from — the verifier's disposable copy is a restore of the implementation snapshot into a
fresh volume.

It is not a rollback point for a failed attempt. On timeout, crash or invalid change the attempt
workspace is deleted rather than restored (§5), so no phase inherits a half-written workspace
because no phase inherits that workspace at all.

Restore validates the archive before deleting anything, so a corrupt or truncated snapshot
leaves the workspace untouched rather than half-written.

### Retention

Snapshots are per-attempt tars of a whole workspace, so keeping them all makes storage grow
without bound. Milestone 3 bounds it with a *termination* rule rather than a live invariant.

While an attempt runs, every snapshot it takes stays in the plan-scoped store, because the
verifier reads those tars during baseline, RED and GREEN. When an attempt reaches a terminal
state, every blob it owns is deleted — except one still referenced by an `accepting` attempt as
its verified acceptance candidate, which goes once its commit is recorded. Startup prunes any
blob no live SQLite row references, which is also what clears a killed process's leftovers.

The hashes remain in the attempt's evidence either way, so a run stays reproducible without
storing every tree forever.

---

## 12. Dependency handling

### Dependency cache

Cache key:

```text
setup runtime image ID
+ lockfile hash
+ install command
+ lifecycle-script policy
```

### Writable dependency volume

Seed a writable attempt-scoped volume:

```text
cached dependency snapshot
→ writable node_modules volume
```

Needed for:

* Prisma;
* Vite;
* Next;
* Nuxt;
* esbuild;
* sharp;
* Playwright;
* Turbo;
* Nx.

Dependency-volume writes are excluded from source diffs.

### Clean verification dependencies

Verifier containers receive a fresh dependency volume seeded from the approved snapshot.

They never reuse the implementation agent’s dependency volume.

### Lifecycle scripts

Default:

```yaml
lifecycle_scripts: denied
```

Exceptions require explicit package approval.

`denied` implies a restricted dependency set. The packages listed above as motivating a writable
dependency volume — esbuild, sharp, Playwright — are precisely the ones that are non-functional
without `postinstall`, so a repository that depends on them cannot run under the default. Either
the repository avoids them, as the Milestone 1 fixture does, or the per-package approval
mechanism must exist before that repository is supported.

---

## 13. Dependency changes

Agents cannot persistently modify:

* `package.json`;
* lockfiles;
* dependency configuration.

V1 has no in-run request protocol and no package-manager adapter. A step that needs a package the
workspace does not have fails on scope validation, and the response is a plan amendment (§30):

```text
step fails on a dependency-manifest change
→ operator commits the exact package and lockfile change
→ amended plan prepared with that commit as its base
→ approval
→ execution resumes from the amended plan's first step
```

The dependency cache key already covers the lockfile hash, so the amended plan's first install is
cold and correct without any further mechanism.

Preapproved exact dependencies may be included in the plan.

---

## 14. Git ownership

Canonical Git belongs only to the harness.

The harness alone may:

* create branches;
* stage;
* commit;
* reset;
* merge;
* update refs;
* push.

Acceptance flow:

```text
implementation snapshot
→ validate diff
→ verify
→ apply exact files to private harness worktree
→ stage exact paths
→ commit with hooks disabled
```

Accepted work lands on one stable branch per plan:

```text
ai-harness/<plan-id>
```

It is created at the approved base by the first acceptance and advanced linearly by each later
step. The ref moves only through `git update-ref` with an expected old value — absent for the
first acceptance, the step's parent commit for every later one — so a branch that was moved,
deleted or created behind the harness's back fails the step instead of being adopted or forced.

An amended plan (§30) is a new plan with its own ID, so it takes its own branch, created at the
previous revision's tip. The chain of revision branches is linear and the newest branch contains
every accepted commit; the harness still never adopts a ref it did not create, it extends one it
did.

Commit trailers:

```text
AI-Harness-Plan: collector-dashboard
AI-Harness-Step: persist-runs
AI-Harness-Attempt: 4f3c1b9a2e5d7801
AI-Harness-Idempotency-Key: ...
```

The idempotency key covers the manifest hash, plan ID, step ID, attempt ID and expected parent,
and reconciliation searches only the plan branch: a commit carrying a matching trailer that the
branch cannot reach is a leftover, not accepted work.

No automatic merge.

---

## 15. Immutable implementation snapshot

After the implementation agent finishes:

```text
implementation workspace
→ immutable implementation snapshot
```

This snapshot is the only candidate for acceptance.

Verification runs on a disposable copy:

```text
immutable implementation snapshot
→ verifier workspace copy
→ tests
→ discard verifier workspace
```

Review packs only the validated added/modified regular files into one disposable volume: modified
files appear under `before/` and `after/`; additions appear only under `after/`. The pinned reviewer
mounts that volume read-only and offline. It receives no dependencies, credentials or canonical Git.

Verifier or reviewer mutations cannot affect accepted source.

Never accept files from verifier or reviewer workspaces.

---

## 16. Harness-owned commands

Commands are fixed arrays:

```ts
execa("npx", [
  "--no-install",
  "vitest",
  "run",
  "--config",
  "vitest.config.ts"
]);
```

Never execute arbitrary model-generated shell strings.

This rule governs the *harness*. Inside its container the agent runs arbitrary shell by design —
that is what the container is for. The rule is about what crosses the boundary back to the host:
nothing a model produced may become an argument the harness executes.

Prefer direct commands over mutable package scripts.

Avoid:

```text
npm test
```

Prefer:

```text
npx --no-install vitest run --config vitest.config.ts
```

Command definitions are included in the approved manifest.

---

## 17. Verification closure

Protect executable verification inputs from the start of the step:

* package manifests;
* lockfiles;
* test-runner configuration;
* setup files;
* TypeScript configuration;
* module aliases;
* environment templates;
* verification scripts;
* coverage configuration.

During test-writing, only declared test paths may change.

After valid RED, only declared implementation paths may change.

Any required closure change triggers test-contract repair.

Repository-provided behavioral checker scripts (§19) are protected by scope rather than by a new
closure list: they must live outside `implementation_paths` and, for `code_behavior`, outside
`test_paths`, where existing diff validation rejects any agent edit to them. V1 does not infer
source paths from arbitrary argv, so placing a checker inside an agent-writable scope is an
accepted trusted-plan authoring error rather than a load-time rejection.

---

## 18. Documentation flow

```text
declared documentation source URLs
→ exact host allowlist derived from those URLs
→ documentation download
→ execution-manifest approval
→ offline implementation context
```

### Documentation authorization

V1 has no planner. A hand-authored plan may declare exact source URLs:

```yaml
documentation:
  sources:
    - url: https://open-meteo.com/en/docs/openapi.json
      path: open-meteo/openapi.json
```

The source list is covered by the plan hash. The downloader derives its exact-hostname proxy
allowlist from those URLs; there is no separate domain list to keep synchronized. The download cap
is fixed harness policy at 50 MB for the complete bundle.

### Documentation downloader

Runs in a dedicated container with:

* access only to hostnames derived from declared source URLs;
* no provider authentication;
* no source write access.

Stores:

* URLs;
* timestamps;
* hashes;
* provenance outside the agent context;
* a deterministic context containing the downloaded text and concise index.

```text
documentation/
  provenance.json
  context/
    index.md
    files/<declared path>
```

`documentation_hash` covers every regular file under `context/` by relative path and content. The
index contains no timestamps; timestamps exist only in provenance. The downloader uses HTTPS,
rejects redirects without following them, and enforces the fixed 50 MB complete-bundle cap.

Downloaded text is untrusted reference data and cannot redefine policy.

V1 has no automatic freshness check or partial refresh. `docs` downloads every declared source only
when the documentation bundle is absent. A valid existing bundle is reused unchanged. An incomplete,
edited or unexpected bundle is an error; the harness does not repair it. To refresh, the operator
deletes the whole documentation bundle and runs `docs` again, which downloads every source again.
If the resulting content hash is unchanged, the existing execution approval remains valid. Changed
content requires a new execution manifest and approval.

The documentation bundle is trusted local operator input. It is validated before execution, and the
operator must not edit or delete it during an active run. Protecting against deliberate concurrent
host edits is out of scope for V1.

---

## 19. Executable plan

Files:

```text
plan.md
plan.yml
execution-manifest.yml
state.db
```

Each step declares:

* ID;
* observable behavior;
* type;
* complexity (`low | medium | high`);
* risk (`standard | high`);
* test paths;
* implementation paths;
* expected test IDs;
* allowed RED categories;
* verification commands;
* an optional runtime block.

### Runtime verification is a step property

A step that must prove its application *runs* declares `verification.runtime`:

```yaml
verification:
  commands:
    - ["npx", "--no-install", "tsc", "--noEmit"]
  runtime:
    start_command: ["node", "src/server.js"]
    port: 3000
    readiness_path: /health
    behavioral_commands:
      - ["node", "harness-checks/runtime-check.mjs"]
```

The block is optional on `task` and on `code_behavior`, and rejected nowhere else because there is
nowhere else. `start_command` and every behavioral command are argv arrays (§16); `port` is 1–65535;
`readiness_path` starts with `/`; at least one behavioral command is required. Runtime configuration
is part of the plan's raw-byte hash.

Everything else is fixed harness policy, part of the policy hash:

```yaml
runtime:
  host: 0.0.0.0
  readiness_timeout_seconds: 60
  command_timeout_seconds: 600
  probe: http-get-200
  environment: [HOST, PORT, HARNESS_APP_URL]
  network: internal
```

The application receives harness-owned `HOST=0.0.0.0` and `PORT`, and must listen on `0.0.0.0`
because the checker reaches it over Docker DNS. Behavioral commands additionally receive
`HARNESS_APP_URL=http://<app-container>:<port>`. A task may neither lower nor raise these.

`observable_behavior` is the text sent to the agent; it replaces the earlier `prompt`. Plan and
step IDs are Git-safe lowercase slugs, because they name a branch and an artifact directory.

The authored order **is** the dependency chain: step N depends on step N-1. Milestone 3 runs one
step at a time, so an explicit `depends_on` and a DAG scheduler would add a second description of
the same fact. `final_verification.commands` is required.

Risk is explicit user-owned data: authorization, financial logic, migrations, destructive local
behavior, concurrency and credential handling are `high`. Services, network requirements and
user-defined review metadata remain rejected rather than stored inert.

---

## 20. Execution manifest

The user approves:

```yaml
execution_manifest:
  repository:
    base_branch: main
    base_commit: abc123

  inputs:
    plan_hash: sha256:...
    policy_hash: sha256:...
    documentation_hash: sha256:...   # only when the plan declares documentation

  runtime:
    harness_version: 0.1.0
    codex_image_id: sha256:...
    claude_image_id: sha256:...
    verifier_image_id: sha256:...
    reviewer_image_id: sha256:...
    setup_image_id: sha256:...
    proxy_image_id: sha256:...
```

Only implemented inputs are present. The plan's raw-byte hash covers complexity, commands, scopes,
verification closure and quarantine. The policy hash covers fixed provider profiles, routing,
provider policies, network and dependency policy. Both provider image IDs are approved even when a
normal route uses only one, because a retry may use Claude.

The base is whatever `prepare` was pointed at. It is the repository head for a first revision and
the previous revision's plan branch tip for an amendment (§30); nothing here treats those two
differently, because an amendment is an ordinary approval.

Approval required for:

* plan changes;
* base-commit changes;
* command changes;
* image changes;
* new domains;
* dependency changes;
* capability expansion;
* routing changes;
* verification-closure changes.

Retries and recovery do not require approval.

---

## 21. Step types

There are two: `task`, the Milestone 1 single-agent pipeline nested inside a plan, and
`code_behavior`, the tests-first pipeline. Either may declare the optional runtime block of §19.

The names `operational` and `mixed` are rejected by the loader, and now denote nothing. Measured
against the code they were never separate pipelines — `operational` is `task` plus a runtime check
and `mixed` is `code_behavior` plus a runtime check — so V1 expresses that difference as one
optional property rather than as two duplicated pipelines and a doubled Docker matrix.

### `task`

```text
implementation
→ static check
→ runtime check, if declared
→ review
→ commit
```

### `code_behavior`

```text
baseline
→ tests
→ RED
→ freeze
→ implementation
→ GREEN
→ static check
→ runtime check, if declared
→ review
→ commit
```

### Runtime check

```text
restore implementation snapshot and clean dependencies
→ run static commands offline
→ create the internal attempt-runtime network
→ start the application detached, from the verifier image
→ poll readiness from one verifier container
→ run behavioral commands sequentially, stopping at the first failure
→ capture application logs
→ remove the container, then the network, then the volumes
```

Readiness has two outcomes that are not the same thing. If the application stays up and never
answers, the readiness deadline expires. If it exits first, the harness observes that from the
host — the probe container has no Docker socket and cannot — ends the probe and reports the exit
rather than waiting out the budget.

Static and runtime verification share one disposable workspace and dependency volume, so a static
command may build what `start_command` launches. The runtime containers mount both read-only,
because a checker the application can rewrite before it runs verifies nothing; `/tmp` is the
writable tmpfs, and an application that needs a path to write must use it. The application and the
checkers receive no provider authentication, no proxy and no egress, and nothing they write can be
accepted: acceptance uses the pre-verification implementation snapshot.

---

## 22. Baseline policy

Before test-writing:

```text
fresh verifier copy
→ clean dependencies
→ offline network
→ focused existing tests
```

Flake policy:

```yaml
baseline:
  retry_failures: 1
  known_flaky_tests:
    - test-id
```

Behavior:

* first failure → rerun;
* passes on retry → warning;
* fails twice → block;
* approved quarantined failure → continue and record.

The quarantine list is approved and hashed.

---

## 23. RED verification

Valid categories:

### Assertion failure

Expected result differs from actual result.

### Missing implementation

Examples:

* missing module;
* missing route;
* missing symbol;
* missing class.

The missing item must fall under approved implementation paths.

### Expected compile/type failure

Valid only when directly caused by the declared missing behavior.

Invalid RED:

* test syntax error;
* broken runner config;
* unrelated missing dependency;
* runner crash;
* unrelated existing failure;
* malformed fixture;
* unexpected skip.

Structured results required:

* JUnit;
* Vitest JSON;
* Jest JSON;
* Pytest JUnit.

Valid RED is category-specific:

* `assertion_failure` requires every expected test ID to be discovered and failed;
* `missing_implementation` accepts collection failure without discovered IDs only when the missing
  relative specifier resolves under an approved implementation path.

`expected_type_failure` is described here but not implemented: nothing concludes it yet, so it is
not a category a task may declare.

Every valid category also requires:

* the category is approved by the task;
* no new unrelated failures;
* no unexpected skips;
* runner completed normally.

---

## 24. GREEN verification

A disposable offline verifier copy:

* uses clean dependencies;
* checks frozen files;
* checks changed paths;
* runs focused tests;
* runs type checking;
* runs lint;
* runs declared runtime checks;
* records results.

Acceptance uses the pre-verification immutable implementation snapshot.

---

## 25. Test-contract repair

A step's tests are approved plan content, so the implementation agent cannot weaken them directly.
When it concludes the contract is unimplementable it writes the dispute marker instead, and the
step stops with `test_contract_disputed`. That category is terminal and is never retried by a
stronger model: a dispute is a claim about the plan, not a model failure.

Repair is a plan amendment (§30), not a separate flow:

```text
implementation reports invalid test contract
→ step fails, plan stops
→ operator revises the step's tests or verifier configuration in the plan
→ approval of the amended plan
→ the step runs again from its parent commit
```

The step reruns whole — baseline, tests, RED, freeze, implementation — rather than resuming from a
restored pre-implementation snapshot. That costs one further test-writing pass and removes a
partial step-resume path nothing else needs.

---

## 26. Post-V1 local service containers

Local dependency services are deliberately deferred until a real project requires one. V1 does
not expose a service schema, accept Compose files or store inert service configuration.

The first required service will introduce the shared lifecycle together with one concrete,
tested harness-owned profile:

```text
create private phase network
→ start service from a pinned image digest
→ wait for a profile-owned readiness check
→ run the agent or verifier using Docker DNS
→ capture service logs
→ destroy service containers, volumes and network
```

The harness will use its existing Docker execution layer, not Docker Compose. Plans will reference
harness-owned profile IDs; they will not provide arbitrary images, mounts, privileges, environment
or Compose definitions.

Every service phase will use fresh state. Profiles will permit only test credentials, no host
mounts, no Docker socket and no host network. Profile content and resolved image IDs will be part
of manifest approval.

---

## 27. Provider adapters

Common responsibilities:

* authentication preparation;
* container invocation;
* model and effort selection;
* structured event parsing;
* secret redaction;
* tool disablement.

### Codex

* pinned CLI version;
* explicit model and effort;
* non-interactive;
* structured output;
* no user config;
* no repository rules;
* no MCP;
* no web tools;
* no auto-update;
* internal sandbox disabled.

#### Container contract

```yaml
codex:
  version: 0.146.0

  invocation:
    strict_config: true
    bypass_inner_sandbox: true
    structured_output: true

  network:
    allowed_hosts:
      - chatgpt.com

  container:
    user: "1001:1001"
    root_filesystem: read_only
    capabilities: []
    no_new_privileges: true
    direct_egress: false

    tmpfs:
      - target: /tmp
        mode: "1777"

      - target: /home/agent
        uid: 1001
        gid: 1001
        mode: "0700"

  timeouts:
    connectivity_smoke_seconds: 60
    setup_seconds: 600
    agent_seconds: 1200
    termination_grace_seconds: 10
```

Conceptual command:

```bash
codex exec \
  --strict-config \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  --ephemeral \
  --ignore-rules \
  --model "$MODEL" \
  "$PROMPT"
```

#### Inner-sandbox bypass is mandatory

Codex sandboxes itself with Bubblewrap, which requires unprivileged user namespaces. Inside the
hardened container it cannot create them, because the container has:

```yaml
capabilities: []
no_new_privileges: true
```

Every Codex execution must therefore pass:

```text
--dangerously-bypass-approvals-and-sandbox
```

This flag disables Codex's inner sandbox and command approvals. It does not bypass the outer
Docker isolation. The container has no host filesystem, no canonical Git, no Docker daemon, no
direct internet, no elevated capabilities and no unrelated credentials.

This is safe only because:

```text
Docker container = security boundary
Codex sandbox    = intentionally disabled
```

Do not weaken Docker to make nested Bubblewrap work.

#### `--strict-config` is required on every execution

Without it, Codex silently accepts unknown configuration fields, so a typo in a generated policy
produces a silently weaker configuration and no error anywhere.

`--strict-config` is accepted by `codex exec`. It is not accepted by `codex features` or other
subcommands, so validation must never be routed through them — an unsupported-flag error looks
like a rejection and scores as a false pass.

A valid regression test distinguishes *flag unsupported* from *invalid configuration correctly
rejected*:

```text
1. run `codex exec --strict-config` with a known-invalid key
   → require non-zero exit
   → require the expected configuration error naming the key
2. run the same invocation with valid configuration
   → require success
```

Step 2 is the positive control. Without it, step 1 alone cannot distinguish a working strict mode
from a broken invocation.

### Claude

Claude Code is pinned at `2.1.221`. Coding uses non-interactive stream JSON, explicit model and
effort, `--safe-mode`, no session persistence, no Chrome, exactly
`Read,Glob,Grep,Edit,Write,Bash`, and one `bypassPermissions` control. `--safe-mode` suppresses
workspace `CLAUDE.md`, plugins, hooks, MCP and other customizations; WebFetch and WebSearch are not
in the tool set. Diagnosis uses the same base policy with `--tools ""`, no permission bypass and no
workspace mount. Both policies use the shared hardened container, exact proxy and timeout ladder.

Subscription auth comes from a manually provisioned `claude setup-token` file. It enters an
attempt-scoped volume, is exported only inside the fixed launcher, and is never rotated or copied
back. `--bare` is not used because it does not read `CLAUDE_CODE_OAUTH_TOKEN`.

---

## 28. Model routing

Profiles are fixed harness policy:

```yaml
codex-fast:
  adapter: codex
  model: gpt-5.6-luna
  effort: medium

codex-deep:
  adapter: codex
  model: gpt-5.6-luna
  effort: high

claude-balanced:
  adapter: claude
  model: claude-sonnet-5
  effort: medium

claude-deep:
  adapter: claude
  model: claude-opus-5
  effort: high
```

Each step declares:

```yaml
complexity: low | medium | high
```

Normal routing:

```text
low    → codex-fast
medium → claude-balanced
high   → codex-deep
```

One profile owns every model phase in an attempt. No normal route uses `claude-deep`; reserving it
for diagnosis and retry guarantees the stronger attempt differs from the failed normal attempt.
Plans cannot override profiles, models, effort or routing.

Retry policy:

```text
retryable normal failure
→ one evidence-only claude-deep diagnosis
→ one fresh claude-deep attempt from the same accepted parent
→ stop
```

Diagnosis reads bounded redacted excerpts from the failed attempt's evidence and has no workspace
or tools. Its text is advisory only; scope and verification remain harness-owned. Diagnosis
failure does not block the retry and never replaces the original failure. `provider_error`,
connectivity/timeouts, setup/baseline failures, test-contract disputes, stronger failures and
commit-plus-cleanup failures are not diagnosed or retried.

---

## 29. Review policy

The V1 reviewer is pinned Semgrep CE with a small vendored JavaScript/TypeScript security-rule
subset. It runs once per verified step with no model, network, provider credentials, dependencies or
canonical Git. `high_risk_steps: required` means critical findings always block and warnings also
block steps whose required `risk` is `high`; standard-step warnings are recorded and continue.

Review scans the same changed regular files before and after, then subtracts the parent multiset by
rule ID, repository-relative path and exact matched-text hash. Added files have no baseline;
deletions and symlinks are not targets. A rename is therefore an addition. Semgrep CE is intra-file,
so this is a narrow deterministic gate, not proof of security and not a replacement for human branch
review. There are no waivers, suppressions or project-supplied rules in V1.

The harness never merges automatically.

---

## 30. Plan amendment

A plan changes for ordinary reasons: a missing prerequisite, a wrong architecture, obsolete future
steps, changed ordering, new documentation, a new dependency, a changed API assumption.

V1 has no repair machinery for any of them. There is no planner to propose an amendment (§18), no
amendment file format, no in-place revision of an approved manifest and no repair approval state.
An amendment is a **new plan revision**: the operator rewrites the plan and approves it exactly as
they approved the first one.

```text
cancel the current plan
→ rewrite the plan, keeping only the steps that still have to run
→ prepare from the previous revision's plan branch tip
→ approve
→ run
```

Concretely:

```bash
harness run <old-manifest> --repo <path>      # optional: finishes an interrupted acceptance
harness cancel <old-manifest> --repo <path>   # releases the repository path
# rewrite the plan: new plan ID, remaining steps only
harness prepare plan-r2.yml --repo <path> \
  --base ai-harness/<previous-plan-id> \
  --output execution-manifest-r2.yml
harness run execution-manifest-r2.yml --repo <path>
```

`--base` is the only new mechanism. It names the commit the amended plan builds on; without it
`prepare` resolves the repository head, which is the first revision's case. A ref is resolved to
its SHA at prepare time, so naming the plan branch reads the branch itself rather than
`plans.head_commit`, which lags it when a process died mid-acceptance.

Accepted history remains immutable because the amended plan never touches it. It has its own plan
ID and therefore its own branch (§14), created at the previous revision's tip and advanced from
there.

Corrections use compensating steps. That is an authoring convention, not a mechanism: a step that
undoes earlier work is an ordinary step of the amended plan.

### What the operator owns

Trimming completed steps out of the amended plan. The harness does not diff plan revisions and
does not know which authored step produced which commit. Leaving a completed step in reruns it,
which fails loudly — a `code_behavior` step whose implementation already exists cannot produce
valid RED — rather than corrupting anything.

Finishing an interrupted acceptance before cancelling. A candidate that was verified but never
committed is lost when the plan is cancelled, so running the old manifest once first is worth it:
reconciliation completes that acceptance and the commit reaches the branch.

Keeping the old manifest file until the plan is cancelled, because `cancel` identifies a plan by
its manifest.

### Not in V1

* planner-generated amendments;
* an amendment format or plan diff;
* in-place revision of an approved manifest;
* `repair_requested` and `awaiting_repair_approval` plan states;
* same-branch step revision. An amended plan whose completed prefix is proven byte-identical could
  keep one branch and one plan row, but that needs per-step hashes, a step revision column —
  amendments usually reuse a step ID, and `steps` is unique on `(plan_row, step_id)` — and new
  recovery paths, all to replace a procedure that already works. It remains a strict superset of
  this one, so nothing here forecloses it.

---

## 31. Persistent state

SQLite:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

Plan states:

```text
draft
approved
running
awaiting_final_review
completed
failed
cancelled
```

Milestone 3 persists the subset it can reach:

```text
approved → running → completed
                   ↘ failed → running   # explicit retry, no new approval
approved/running/failed → cancelled
```

A failed plan stays active — the same approved manifest may retry it — so one non-completed,
non-cancelled plan owns a canonical repository path at a time. That ownership is a uniqueness
constraint, not a process lock: concurrent production runs remain unsupported because the startup
sweep is global.

An amendment does not reopen a plan. Cancelling releases the repository path, and the amended plan
registers as a new row with its own ID, manifest and branch (§30). Nothing rewrites an existing
plan's steps, so no state here describes a plan under repair.

Attempt states are only those recovery has to tell apart:

```text
running → accepting → completed
running/accepting → failed
```

`failed` is terminal for that attempt; an explicit retry is a new attempt with a new ID and
ordinal. A `running` row found at startup belongs to a process that died, so its ID is reused and
the whole step reruns from its stored parent.

The execution phase — `preparing`, `baseline`, `tests`, `red`, `implementation`, `green`,
`verify`, `runtime`, `review` — is a diagnostic column recording where an attempt was, not a
second state machine. It carries no `CHECK` constraint, so adding a phase leaves the schema
version unchanged.

Recovery reconciles:

* SQLite;
* plan branch;
* commit trailers;
* workspace snapshots;
* volumes;
* containers;
* artifacts.

If commit exists but SQLite says `accepting`, finish the database transition without rerunning.

---

## 32. Artifacts

Store:

* prompts;
* redacted events;
* container logs;
* proxy metadata;
* baseline results;
* RED results;
* GREEN results;
* runtime verdicts and application logs;
* review findings;
* source diffs;
* manifests;
* snapshots;
* runtime image IDs;
* dependency cache keys;
* plan revisions;
* usage metadata.

Snapshots are the exception to "store": §11 makes them bounded, so what is permanently retained
is their hashes in the attempt evidence, not the trees themselves.

Never store:

* raw authentication;
* unredacted tokens;
* Docker credentials.

---

## 33. Metrics foundation

Record from V1:

* provider;
* model;
* effort;
* phase;
* duration;
* token usage;
* exact, reported, estimated or unknown cost;
* retries;
* verification outcome;
* failure category;
* amendments;
* human decisions.

Future metrics:

* first-attempt success;
* step success;
* plan completion;
* cost per successful step;
* amendment rate;
* interruption rate;
* model success;
* flake rate;
* dependency-cache hit rate;
* container startup time.

Future dashboard remains read-only.

---

# 34. Milestones

## Milestone 1 — Docker Codex Task Runner

Adds:

* Codex image;
* authentication feasibility;
* private networks;
* CONNECT proxy;
* named-volume workspace;
* synthetic Git;
* writable dependencies;
* snapshots;
* one task;
* fixed verification;
* source diff;
* harness-owned commit.

Working result:

```text
task → isolated Codex → verification → commit
```

## Milestone 2 — Tests-First Code Step

Adds:

* structured step;
* baseline;
* flake handling;
* expected test IDs;
* RED taxonomy;
* structured parser;
* freeze policy;
* immutable implementation snapshot;
* disposable verifier copy;
* GREEN;
* test-contract repair.

Working result:

```text
behavior → RED → implementation → GREEN → commit
```

## Milestone 3 — Autonomous Plans

Adds:

* full plan;
* execution manifest;
* SQLite;
* implicit linear dependencies between steps;
* automatic progression;
* recovery and reconciliation;
* idempotent acceptance;
* offline final verification;
* bounded snapshot retention;
* `prepare` / `run` / `cancel`.

Working result:

```text
approved plan → autonomous branch
```

## Milestone 4 — Claude and Routing

Adds:

* Claude image;
* Claude authentication;
* provider profiles;
* complexity routing;
* stronger retry;
* failure diagnosis.

## Milestone 5 — Review and Risk Gates

Adds:

* required per-step risk;
* pinned offline static reviewer;
* introduced critical findings and warnings;
* risk-dependent blocking before acceptance;
* bounded stronger retry for `review_blocked`.

There is no composed final review. Every changed file is scanned by the step that last changes it,
and CE rules are intra-file, so the branch-head content cannot create a new blocking combination.
Revisit this only if interfile analysis is introduced.

## Milestone 6 — Runtime and Behavioral Checks

Adds:

* an optional `verification.runtime` block on `task` and `code_behavior` steps;
* detached application startup in a hardened container;
* private offline runtime-check networks;
* readiness and behavioral checks from a verifier container;
* application log capture;
* deterministic teardown on success, failure and timeout.

Working result:

```text
implementation snapshot → isolated application startup → behavioral verification → commit
```

## Milestone 7 — Documentation Workflow

Adds:

* exact source approval and derived host allowlisting;
* downloader;
* OpenAPI bundles;
* provenance;
* manual bundle-wide refresh by deletion; no automatic freshness;
* offline implementation context.

## Milestone 8 — Plan Amendment

Adds:

* `prepare --base <commit-ish>`, resolved to a full SHA at prepare time, so an approved plan can
  build on a previous revision's plan branch instead of on the repository head;
* the amendment procedure of §30 — cancel, rewrite, prepare from the plan branch tip, approve, run
  — as the single answer to a blocked plan;
* step insertion, removal, reordering and rewriting, by rewriting the plan;
* compensating steps as ordinary steps of an amended plan;
* dependency changes (§13) and test-contract repair (§25) as amendment procedures rather than as
  protocols of their own;
* a prepare-time guard rejecting a step ID already carried by an `AI-Harness-Step` trailer
  reachable from the base commit, which catches an amended plan that still lists a completed step.

Working result:

```text
blocked plan → amended plan → one linear chain of revision branches
```

No repair state machine, no amendment format and no planner. An amendment is an ordinary approval
of an ordinary plan whose base happens to be the previous revision's accepted work, which is why
this milestone is one flag and a documented procedure rather than a subsystem.

## Milestone 9 — Metrics and Feedback

Adds:

* cost accounting;
* aggregate metrics;
* failure taxonomy;
* structured feedback;
* evaluation exports.

## Milestone 10 — Read-Only Dashboard

Adds:

* active runs;
* timelines;
* artifacts;
* diffs;
* costs;
* model comparison;
* amendment history.

## Post-V1 Milestone 11 — Local Services

Adds, when demanded by a real project:

* harness-owned service profiles, one concrete service at a time;
* pinned service image IDs in manifest approval;
* per-phase service networks and fresh state;
* profile-owned readiness checks;
* service logs, timeout handling and deterministic cleanup.

Docker Compose and repository-provided service definitions remain unsupported.

---

## 35. Pre-Milestone-1 feasibility gates

Validate before implementation planning:

1. Codex subscription auth works in Linux ARM64 container.
2. Token refresh behavior is understood.
3. Claude subscription auth works in Linux ARM64 container.
4. Provider terms permit intended automation.
5. Required provider domains are known.
6. Provider traffic works through CONNECT proxy.
7. Containers have no direct egress.
8. Non-root execution works.
9. Read-only root works.
10. Named-volume performance is acceptable.
11. Snapshot and restore work.
12. OrbStack limits and network behavior work.
13. Auto-update and telemetry can be disabled.
14. Authentication persistence mode is selected explicitly.

### Status

Gates 1, 2, 5–13 executed and passed against `codex-cli 0.146.0` on OrbStack `linux/arm64`.
Gate 3 executed and passed against Claude Code `2.1.221` on the same runtime. Gate 4 was accepted by
the operator for this local, trusted-repository deployment. Gate 14 is selected.

The gates are now regression tests, not one-time checks. Each runs with a paired positive control;
an unattempted operation is not evidence of enforcement, so a missing control makes the result
inconclusive, and an inconclusive required check counts as a failure.

Regression suite:

* writable `/home/agent`;
* non-root execution;
* read-only root filesystem;
* Codex inner sandbox disabled;
* exact `chatgpt.com` egress;
* `ab.chatgpt.com` denied;
* WebSocket works through CONNECT;
* direct egress unavailable;
* provider outage terminates by timeout;
* invalid configuration rejected by `--strict-config`;
* valid configuration accepted;
* attempt workspace disposed after timeout.

### Findings from the Milestone 1 implementation

Established while building against `codex-cli 0.146.0`; each changed a decision.

* **Provider config keys are version-specific and must be validated empirically.**
  `[features].web_search_request` and `web_search_cached` are deprecated in this version and
  produce errors; the working key is top-level `web_search = "disabled"`. `--strict-config`
  turns a wrong key into a loud failure, which is why it is mandatory rather than advisory.
* **Model names carry metadata.** `gpt-5.6-luna` resolves cleanly; `gpt-5.1-codex-max` logs
  "model metadata not found" and falls back, degrading performance silently.
* **Bind-mount ownership mapping is runtime-specific.** On OrbStack and Docker Desktop a host
  directory owned by the invoking user appears inside the container as the container's own uid;
  on native Linux the numeric ownership must match. Rather than `chown` a user's own
  credentials, `/run/agent-auth` is an attempt-scoped volume — see §5.
* **Captured container output is not the container's output by default.** `execa` strips a final
  newline unless told not to, so a file read back through a container came out one byte short of
  the original. Anything claiming a byte-identical round trip has to disable that.
* **Named volumes take their ownership from the image's mount point.** A fresh volume mounted at
  a path the image owns as `1001:1001` comes up writable; mounted at a path the image does not
  have, it comes up `root:root` and a non-root container cannot write it.
* **The setup phase needs the timeout ladder too.** `npm ci` without network exhausts a registry
  retry ladder for roughly 70 seconds before failing — the same "hang, not error" shape §5
  describes for the agent phase. Every phase that can reach a network needs a deadline.
* **Network teardown must account for attached containers.** `docker network rm` fails while a
  container is still attached, and a tolerant remove hides that as a silent leak. Containers must
  be destroyed before the networks they sit on.

### Findings from the Milestone 3 implementation

Established while building autonomous plans; each changed a decision.

* **Reconciliation must precede the branch-collision guard.** An acceptance interrupted between
  the commit and the database write legitimately leaves a commit on the plan branch that SQLite
  has not recorded. Checking "this plan has accepted nothing, so the branch must not exist" first
  reports the plan's own work as somebody else's ref.
* **Claiming an artifact ordinal has to create the directory.** An executor that dies before
  writing anything otherwise leaves `run-2` unclaimed, and the next recovery run writes over the
  evidence of the one before it.
* **A returned failure and a killed process are different states, and only one is recoverable.**
  An attempt that *reports* a failure has had its own error handling run and is terminal. An
  attempt left `running` or `accepting` is one whose process died, and is the only case where
  reusing an ID or finishing an acceptance is sound.
* **Content-addressed stores need paths, not hashes, to delete by.** Workspace snapshots are
  stored bare and exported trees as `.tar`, so a prune that reconstructs a filename from a hash
  plus a guessed extension silently deletes nothing.
* **`node:sqlite` needs no opt-in flag from Node 22.13.** Measured: 22.12 raises
  `ERR_UNKNOWN_BUILTIN_MODULE` without `--experimental-sqlite`; 23.7 works unflagged. Its
  experimental warning goes to stderr, so stdout stays valid JSON.
* **A stable plan branch changes what a shared fixture repository means.** With one branch per
  plan rather than one per attempt, a second run against the same repository correctly refuses to
  adopt the first run's branch — so suites that reuse a fixture must clear it, exactly as an
  operator does between plans.

### Findings from the Milestone 4 Claude feasibility gate

Established against Claude Code `2.1.221` on OrbStack `linux/arm64` before routing implementation.

* **Subscription automation is an explicit human decision.** The operator accepted this local,
  trusted-repository, bounded use as ordinary individual Claude Code usage after reviewing
  Anthropic's published Consumer Terms, Claude Code legal page and authentication documentation.
* **The setup token is manually provisioned, not imported.** `claude setup-token` produces a static,
  inference-only token. The operator writes it once to the private harness state file (`0700`
  directory, `0600` file) before a Claude-backed run. The harness reads it, streams it into an
  attempt-scoped volume and never writes or rotates the host file. `--bare` is not used because it
  does not read `CLAUDE_CODE_OAUTH_TOKEN`.
* **The minimal invocation is flag-driven.** Coding uses `-p`, stream JSON, verbose mode,
  no session persistence, `--safe-mode`, no Chrome, exactly `Read,Glob,Grep,Edit,Write,Bash`, one
  `bypassPermissions` control, and pinned model/effort. Diagnosis uses the same base with no tools,
  no permission mode and no workspace.
* **`--safe-mode` suppresses repository rules but not all metadata.** A workspace `CLAUDE.md` canary
  did not reach the model. The init event still advertised built-in command, skill and agent
  metadata; those capabilities were not callable because `Skill` and `Agent` were absent from the
  exact tool set. MCP servers and plugins were empty.
* **One host is sufficient.** Authenticated coding and diagnosis completed through a CONNECT proxy
  allowing only `api.anthropic.com`; a non-allowlisted host was denied and the agent had no direct
  egress.
* **JSONL has a provider-owned terminal error signal.** Provider refusal exits non-zero with a
  terminal `result` carrying `is_error=true`, `terminal_reason=api_error` and numeric
  `api_error_status`. `provider_error` is concluded from those fields, never wording. A wrong model
  returned that signal with `404` and zero usage rather than silently falling back.
* **Requested and reported model evidence is direct.** The init event reports the requested pinned
  model. Successful terminal results contain non-empty text and usage; coding reported
  `claude-sonnet-5` and diagnosis reported `claude-opus-5`.
* **The credential stays out of Docker metadata and artifacts.** The token enters an offline helper
  on stdin, the fixed launcher exports it only inside the provider process, and canary scans found it
  in neither inspect data, stdout/stderr nor proxy records.
* **Claude needs the same timeout ladder.** Against a blackholed CONNECT tunnel it did not exit during
  the full 1,200-second agent budget. The harness's SIGTERM/grace/SIGKILL ladder terminated it, and
  final inspection found no gate container, volume or network. The complete Docker/stub/global
  regression suite also passed without a Claude-specific hardening exception; substituting the
  pinned Claude image into production `runContainer` passed identity, filesystem, capability,
  offline-network, timeout and cleanup controls.

### Findings from the Milestone 4 implementation

* **A profile must own the whole attempt.** Switching providers between tests and implementation
  would multiply auth, recovery and evidence states. V1 persists one profile before execution and
  reuses it after a crash.
* **The stronger profile cannot be a normal route.** `claude-deep` is reserved for diagnosis and
  retry; otherwise a high-complexity failure could only receive an identical re-roll.
* **Provider refusal is not a repair signal.** Structured Claude API errors and the equivalent Codex
  refusal are `provider_error`. They stop without diagnosis or retry. Quota is never deliberately
  exhausted to distinguish its wording; the structured provider category is sufficient.
* **Diagnosis is evidence, not authority.** It receives bounded redacted artifact excerpts, no
  workspace and no tools. Its result is non-overwriting advisory text; plan scope, commands and
  verification cannot be changed by it. A failed diagnosis still permits the one stronger retry.
* **Terminal failure is one database write.** Attempt failure, failure detail and plan failure commit
  in one SQLite transaction. A process killed before report writing therefore resumes the pending
  stronger child or reports the durable terminal cycle; it cannot observe a terminal attempt beside
  a running plan.
* **Schema version 2 needs only retry identity.** Attempts add `profile_id` and nullable
  `retry_of_attempt_row`. Attempt kind is derived from that relationship rather than stored twice.
  There is deliberately no migration framework; old state fails clearly and operators start fresh.
* **Subscription credit is operational state.** Since 2026-06-15, Claude Code subscription calls use
  the plan's separate Agent SDK credit. The harness neither measures nor routes around that balance;
  operators check it before enabling medium routes, diagnosis or stronger retry.

### Findings from the Milestone 5 implementation

* **Both fixed scan roots must always exist.** An added-only change has no `before/` file, but Semgrep
  treats a missing fixed root as target-discovery failure. The review tar therefore always contains
  empty `before/` and `after/` directories before file entries are added.
* **Reduced scanner evidence is the safe artifact.** Scanner messages and matched source never enter
  `scan.json` or `review.json`; only rule ID, relative path, location and mapped severity survive.
* **Review needs no new durable state.** The existing text phase records `review`, failures use the
  existing atomic terminal transaction, and reports load summaries from attempt artifacts. Schema
  version remains 2.

### Findings from the Milestone 6 implementation

* **`--rm` and evidence are incompatible for a detached application.** `buildRunArgs` added `--rm`
  unconditionally, so an application that crashed on startup was removed by Docker before
  `docker logs` could run — deleting precisely the evidence that failure needs. Retention became
  explicit (`autoRemove`), paired with a loud removal helper, because a container nothing removes
  automatically is one whose leak must not be silent.
* **One deadline, not two racing ones.** The readiness probe owns a deadline and the §5 container
  ladder backs it. A probe exit of 3 means the deadline expired and is reported as a timeout; any
  other non-zero exit is the probe itself failing and is reported as a failure. Collapsing both
  into "timeout" would have been a false statement about what happened.
* **A failing verdict has to survive a failed teardown.** A leaked container must never erase the
  `verification_failed` a step is actually about, so a failing runtime check returns its verdict
  with the cleanup error recorded beside it. On the passing path the leak still fails the step:
  a run that leaked is not a successful run. The rule has to hold for the *whole* teardown, not
  just the container: the phase-network scope removes its network after the check returns and
  throws if it cannot, which put the verdict back at risk in exactly the case that produces both
  failures at once — the container that could not be removed is what still holds an endpoint on
  the network. Both cleanup errors are now recorded on the same surviving verdict.
* **A shared writable workspace makes the gate bypassable.** The application and its behavioral
  checkers run against one workspace, so an application that can write to it can rewrite the
  checker that is about to judge it — measured against a server that tried. The runtime
  containers therefore mount the workspace and dependencies read-only and write to the `/tmp`
  tmpfs. Static verification keeps its writable mounts, so builds are unaffected; the cost is
  that an application which writes into its own tree must be pointed at `/tmp` for the check.
* **Static and runtime verification need one workspace acquisition, not two.** Restoring the
  snapshot again for the runtime phase would discard whatever a static command had just built, so
  the verifier-workspace ownership scope was extracted and both phases run inside it.
* **The readiness probe's argv is not evidence.** It is the entire fixed probe source; recording it
  would bury the verdict it sits beside. `runtime.json` records the readiness *target* instead.
* **The probe cannot see the process it is waiting for, so the host watches it.** The probe
  container has the runtime network and nothing else — no Docker socket, by design — so it cannot
  distinguish "not listening yet" from "already dead" and polled a corpse for the whole 60-second
  budget. The harness now watches the application container from the host while readiness runs and
  terminates the probe the moment it exits. Measured: 61 s → under 1 s. The kill is an
  optimization and the container ladder remains the real deadline; what is load-bearing is that
  an exited application is reported as *exited*, not as a deadline that expired.
* **Killing a container that does not exist yet reports success.** `docker run` creates its
  container asynchronously, so a kill issued while the application is crashing on startup can
  arrive before there is anything to kill — and Docker calls removing an absent container
  success, so the attempt looks like it worked. A single attempt therefore let the probe run its
  whole budget on a loaded daemon while the fast path silently did nothing; the kill is retried
  until the probe actually settles.
* **A wall-clock assertion is not a latency assertion.** The first version of the fast-fail test
  measured the whole pipeline run against the readiness budget, so it passed on an idle machine
  and failed under load for reasons unrelated to what it claimed. Bounding the *recorded*
  readiness duration is the same claim without the daemon's load in it — and it is what caught
  the race above.

### Findings from the Milestone 7 implementation

* **A CONNECT-only proxy decides what a positive control can be.** The proxy serves CONNECT and
  nothing else (§7), so the downloader's `fetch` reaches an origin only over TLS. A local test
  origin would therefore need a certificate the container trusts, which is a CA injection the
  design forbids. The Docker suite consequently owns the negative controls — a host outside the
  derived allowlist is denied and recorded, and without proxy configuration the phase network
  reaches nothing — and the one positive control, "a declared source really downloads", is a live
  test needing the internet but no credential and no tokens.
* **`path.join` treats an absolute path as relative, so containment checks need their own
  absolute test.** `join('/bundle/files', '/etc/passwd')` is `/bundle/files/etc/passwd`, which a
  `relative()`-based check happily reports as inside the tree. The declared storage path is
  therefore tested for an absolute prefix directly, in addition to the traversal check.
* **Phase network roles are global, not per-phase.** The topology invariant is that no two phases
  share an egress-capable role, so the documentation phase could not reuse the agent phase's
  `egress` / `proxy-egress` names even though it has the same shape. It carries its own.
* **The prompt the manifest hashes and the prompt the agent receives must be composed once.** The
  provider policy is compiled from the prompt before the agent runs, and the agent phases compose
  theirs separately; adding a second appended paragraph to only some of those sites would record
  a hash for text that was never sent. All of them now go through one composer.

### Conclusion

Milestone 1 is feasible with a simpler security model than earlier drafts assumed:

```text
hardened Docker container
+ exact chatgpt.com egress
+ Codex inner sandbox disabled
+ strict configuration validation
+ mandatory timeouts
```

No Codex permission-profile compiler and no inner-sandbox self-test are needed. Provider-native
confinement is not part of the security model; Docker is.

---

## 36. Recommended defaults

```yaml
execution:
  backend: docker
  container_per_phase: true
  workspace_storage: named_volume
  synthetic_git: true
  expose_canonical_git: false

security:
  trusted_repositories_only: true
  cloud_model_access: allowed
  authentication_mode: agent_readable_subscription
  provider_inner_sandbox: disabled
  provider_web_tools: disabled
  external_writes: unsupported

container:
  non_root: true
  user: "1001:1001"
  read_only_root: true
  capabilities: []
  no_new_privileges: true
  docker_socket: false
  tmpfs_numeric_ownership: required

provider:
  strict_config: true
  bypass_inner_sandbox: true
  structured_output: true

network:
  exact_host_matching: true
  wildcards: unsupported
  tls_interception: never

timeouts:
  connectivity_smoke_seconds: 60
  setup_seconds: 600
  agent_seconds: 1200
  termination_grace_seconds: 10

dependencies:
  writable_attempt_volume: true
  lifecycle_scripts: denied
  agent_manifest_changes: prohibited

verification:
  disposable_workspace_copy: true
  clean_dependencies: true
  direct_commands: true
  baseline_retry_failures: 1

review:
  read_code_after_finish: true
  high_risk_steps: required

routing:
  deterministic: true
  stronger_retries: 1
```

Final execution model:

```text
Approved plan
→ isolated agent container
→ immutable implementation snapshot
→ disposable offline verifier
→ pinned offline review of changed files
→ deterministic acceptance or explicit finding-backed stop
→ harness-owned commit
→ next step
→ final verification
```
