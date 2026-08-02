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
* plan repair;
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
* one step at a time;
* local service containers;
* public or server-enforced read-only API checks.

Not supported:

* untrusted repositories;
* Kubernetes;
* Docker-in-Docker;
* agent Docker access;
* parallel agents;
* remote workers;
* production deployment;
* external writes;
* automatic merge;
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
    ├── egress proxy
    └── local test services
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
→ restore pre-invocation workspace snapshot
→ classify failure
```

Restoration is not specific to the timeout path. Once the pre-agent snapshot exists, **every**
failure that can leave the agent workspace half-written restores it before the error propagates:
a killed agent, one that exited non-zero, an unparseable event stream, and a change that fails
scope, dependency-manifest or symlink validation. The restored workspace is snapshotted again and
both hashes are recorded, so "it was restored" is checkable rather than asserted — equal hashes
are the evidence. A restoration that fails is reported alongside the phase failure, never in
place of it.

Verifier failure is deliberately excluded. Verification runs against a disposable copy of the
implementation snapshot, so there is nothing in the agent workspace to undo; the copy is simply
removed. Restoring there would be a no-op dressed up as a safety property.

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
├── attempt-services-net
└── agent-egress-net
    └── provider proxy
```

### Offline verifier

Without services:

```text
network_mode: none
```

With local services:

```text
verifier
└── attempt-services-net
```

The verifier cannot reach the proxy.

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

### External integration phase

```text
integration verifier
└── integration-egress-net
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

## 8. External verification limits

CONNECT allowlisting cannot enforce read-only HTTP behavior.

Live verification is permitted only for:

1. public unauthenticated APIs where writes are unavailable;
2. credentials with server-enforced read-only permissions;
3. local mocks or recorded fixtures.

Generic authenticated API access is not described as read-only.

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

On:

* timeout;
* crash;
* invalid change;
* failed retry;

restore the snapshot.

No phase inherits a half-written workspace.

Restore validates the archive before deleting anything, so a corrupt or truncated snapshot
leaves the workspace untouched rather than half-written.

### Retention

Snapshots are per-attempt tars of a whole workspace, so storage grows without bound. Milestone 1
keeps every snapshot — one task per run, so the volume is small — and defers a retention policy.
Any milestone that runs multi-step plans needs one before it ships.

---

## 12. Dependency handling

### Dependency cache

Cache key:

```text
runtime image digest
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

Dependency request flow:

```text
agent requests exact package/version
→ human approves
→ harness package-manager adapter updates files
→ dependency snapshot rebuilt
→ execution manifest updated
→ baseline and RED restart
```

Initial milestones may block all dependency changes.

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

Commit trailers:

```text
AI-Harness-Plan: collector-dashboard
AI-Harness-Step: persist-runs
AI-Harness-Attempt: 2
AI-Harness-Idempotency-Key: ...
```

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

Review runs on another disposable copy.

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

---

## 18. Planning flow

```text
repository analysis
→ preliminary plan
→ documentation requirements
→ documentation-domain approval
→ documentation download
→ final executable plan
→ execution-manifest approval
```

### Documentation authorization

Separate from implementation approval:

```yaml
planning:
  documentation:
    official_sources_only: true
    allowed_domains:
      - open-meteo.com
    maximum_download_mb: 50
```

### Documentation downloader

Runs in a dedicated container with:

* approved-domain access;
* no provider authentication;
* no source write access.

Stores:

* URLs;
* timestamps;
* hashes;
* provenance;
* OpenAPI;
* Markdown pages;
* concise index.

Downloaded text is untrusted reference data and cannot redefine policy.

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
* dependencies;
* complexity;
* risk;
* test paths;
* implementation paths;
* expected test IDs;
* allowed RED categories;
* verification commands;
* services;
* network requirements;
* review requirements.

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
    project_config_hash: sha256:...
    commands_hash: sha256:...
    services_hash: sha256:...
    documentation_hash: sha256:...
    routing_hash: sha256:...
    network_policy_hash: sha256:...
    dependency_policy_hash: sha256:...
    quarantine_hash: sha256:...

  runtime:
    harness_version: 0.1.0
    agent_image_digest: sha256:...
    verifier_image_digest: sha256:...
    setup_image_digest: sha256:...
    proxy_image_digest: sha256:...
```

Approval required for:

* plan changes;
* base-commit changes;
* command changes;
* image changes;
* new domains;
* dependency changes;
* service changes;
* capability expansion;
* routing changes;
* verification-closure changes.

Retries and recovery do not require approval.

---

## 21. Step types

### `code_behavior`

```text
baseline
→ tests
→ RED
→ freeze
→ implementation
→ GREEN
→ review
→ commit
```

### `operational`

```text
baseline
→ implementation
→ static check
→ startup check
→ behavioral check
→ review
→ commit
```

### `mixed`

```text
baseline
→ tests
→ RED
→ code and operational implementation
→ GREEN
→ local runtime check
→ review
→ commit
```

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

Valid RED requires:

* expected tests discovered;
* expected tests failed;
* approved failure category;
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

Required from the first tests-first milestone.

```text
implementation reports invalid test contract
→ restore pre-implementation snapshot
→ propose test amendment
→ human approval
→ revise tests or verifier config
→ rerun RED
→ freeze again
→ restart implementation
```

The implementation agent cannot weaken tests directly.

---

## 26. Local service containers

Supported:

* PostgreSQL;
* Redis;
* RabbitMQ;
* MinIO;
* local mock APIs.

Profiles are harness-owned:

```yaml
services:
  postgres-test:
    image: postgres@sha256:...
    environment:
      POSTGRES_DB: test
      POSTGRES_USER: test
```

Rules:

* image digest pinned;
* no host mounts;
* no Docker socket;
* no host network;
* private attempt network;
* test credentials only;
* destroyed afterward.

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

* pinned CLI version;
* explicit model;
* non-interactive;
* controlled local tools;
* no WebFetch;
* no WebSearch;
* no MCP;
* no auto-update;
* no nested-sandbox dependency.

---

## 28. Model routing

Profiles:

```yaml
codex-fast:
  adapter: codex
  effort: medium

codex-deep:
  adapter: codex
  effort: high

claude-balanced:
  adapter: claude

claude-deep:
  adapter: claude
```

Each step declares:

```yaml
complexity: low | medium | high
risk: normal | high
```

Typical routing:

```text
planning          strong model
test writing      fast model
implementation    complexity-based
diagnosis         stronger model
review            independent model
```

Retry policy:

```text
normal attempt
→ diagnosis
→ one stronger retry
→ stop
```

---

## 29. Review policy

```yaml
review:
  read_code_after_finish: true
  high_risk_steps: required
```

High-risk examples:

* authentication;
* authorization;
* financial logic;
* migrations;
* destructive local behavior;
* concurrency;
* credential handling.

Normal verified steps continue automatically.

The harness never merges automatically.

---

## 30. Plan repair

Full plan repair handles:

* missing prerequisites;
* wrong architecture;
* obsolete future steps;
* changed ordering;
* new services;
* new documentation;
* new dependencies;
* API-assumption changes.

```text
step blocked
→ planner proposes amendment
→ user approves amendment
→ manifest revision
→ execution resumes
```

Accepted history remains immutable.

Corrections use compensating steps.

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
repair_requested
awaiting_repair_approval
awaiting_final_review
completed
failed
cancelled
```

Attempt states:

```text
preparing
baseline_verified
writing_tests
red_verified
implementing
verified
reviewing
accepting
completed
```

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
* review findings;
* source diffs;
* manifests;
* snapshots;
* image digests;
* dependency cache keys;
* plan revisions;
* usage metadata.

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
* repairs;
* human decisions.

Future metrics:

* first-attempt success;
* step success;
* plan completion;
* cost per successful step;
* repair rate;
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
* dependencies between steps;
* automatic progression;
* recovery;
* idempotent acceptance;
* final verification.

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

* independent reviewer;
* critical findings;
* warnings;
* high-risk review;
* optional final review.

## Milestone 6 — Local Services

Adds:

* PostgreSQL;
* Redis;
* RabbitMQ;
* operational steps;
* mixed steps;
* startup and behavioral checks.

## Milestone 7 — Documentation Workflow

Adds:

* domain approval;
* downloader;
* OpenAPI bundles;
* provenance;
* freshness;
* offline implementation context;
* constrained external verification.

## Milestone 8 — Full Plan Repair

Adds:

* amendments;
* future-step insertion/removal/reordering;
* compensating steps;
* dependency and service escalation.

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
* repair history.

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
Gate 14 is selected. Gate 3 belongs to Milestone 4. Gate 4 is a human decision and remains open.

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
* workspace restored after timeout.

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
→ deterministic acceptance
→ harness-owned commit
→ next step
→ optional final review
```
