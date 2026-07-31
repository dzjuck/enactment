# Universal AI Plan-Implementation Harness

## Final Version 1 Design

## 1. Executive summary

The harness is a local TypeScript application that turns an approved implementation plan into autonomous, controlled code changes.

It uses the Codex CLI and Claude Code subscriptions already available on the user’s machine. It does not call model APIs directly and does not implement its own coding agent.

The core workflow is:

```text
Trusted repository
→ repository and documentation analysis
→ executable implementation plan
→ one-time approval
→ autonomous execution of plan steps
→ deterministic verification
→ plan repair or human review only when necessary
→ reviewable Git branch
```

Version 1 uses:

* native Codex and Claude security mechanisms;
* a fresh plain workspace for every step;
* no `.git` access for the agent;
* no Docker daemon;
* no Docker Compose;
* no Kubernetes;
* no OpenHands;
* no general execution-time internet access;
* harness-owned verification and Git commits;
* structured RED/GREEN validation;
* persistent state and crash recovery.

The harness adds significantly more automation than invoking an agent with:

> Execute the plan using `plan-step`.

It can continue through normal verified steps automatically rather than requiring approval after every step.

The existing `plan-builder` remains the conceptual foundation for plan quality: steps should be atomic, introduce one observable behavior, use tests first for code behavior, use implementation plus explicit verification for operational work, and leave the system working.

The current `plan-step` rules remain the foundation for execution integrity: exactly one step at a time, RED before implementation, no silent modification of tests, and explicit handling when the test contract must change.

---

# 2. Version 1 scope

Version 1 is designed for:

* repositories owned and trusted by the user;
* local execution on macOS or another supported development machine;
* Codex CLI;
* Claude Code;
* subscription-based authentication;
* one active plan per repository;
* one active step at a time;
* autonomous execution;
* native agent security restrictions;
* local project tools;
* Git-based review and rollback.

Version 1 does not support:

* untrusted third-party repositories;
* Docker as an execution backend;
* Docker Compose service management;
* Kubernetes;
* virtual machines;
* remote execution workers;
* CI execution;
* parallel plan steps;
* multiple simultaneous implementation agents;
* automatic production deployment;
* automatic merge into the base branch;
* OpenHands;
* Web UI;
* IDE integration;
* MCP;
* local or on-premises models.

A plan requiring one of these unsupported capabilities must stop clearly rather than perform weaker verification.

Example:

```yaml
status: blocked

unsupported_capability:
  type: execution_backend
  value: docker
```

---

# 3. Product goals

## 3.1 High autonomy

The user should approve the plan once and then allow normal work to continue without approving every command or every ordinary step.

The agent may autonomously:

* inspect allowed source files;
* search the repository;
* edit allowed files;
* write tests;
* run tests while developing;
* run type checking and linting;
* start an approved local application process;
* use approved local mock services;
* inspect generated changes;
* diagnose failed verification;
* retry according to the approved escalation policy.

The harness pauses only for meaningful decisions:

* a plan amendment;
* a test-contract change;
* a capability expansion;
* a high-risk step when review is required;
* repeated failure;
* an irreversible external operation;
* final code review when enabled.

## 3.2 Deterministic control

AI performs reasoning and implementation.

Deterministic software controls:

* approved inputs;
* legal state transitions;
* repository scope;
* security policies;
* official verification commands;
* test integrity;
* Git history;
* retries;
* review gates;
* plan completion.

## 3.3 Simplicity

Version 1 should not attempt to become:

* a general agent platform;
* a container orchestration system;
* an enterprise security product;
* an observability platform;
* a multi-agent framework.

It should be a small, reliable execution layer around existing coding agents.

## 3.4 Project independence

The harness must not contain dashboard-specific or language-specific orchestration logic.

Project-specific behavior is supplied through configuration:

* test commands;
* verification commands;
* allowed paths;
* architecture documents;
* local service commands;
* external API documentation;
* risk classifications;
* agent profiles.

---

# 4. What the harness is

The harness is primarily deterministic TypeScript code.

```text
AI Harness
├── CLI
├── configuration loader
├── plan loader and validator
├── execution-manifest compiler
├── state machine
├── policy engine
├── documentation manager
├── workspace manager
├── Codex adapter
├── Claude adapter
├── verification runner
├── model router
├── review runner
├── Git manager
├── SQLite storage
└── artifact store
```

The harness launches existing agents:

```text
Harness
├── Codex CLI
└── Claude Code
```

The harness does not implement:

* its own model;
* its own shell agent;
* its own source-code editing tools;
* its own operating-system sandbox.

It translates a common security policy into Codex- and Claude-specific configurations and verifies that the required restrictions actually work.

---

# 5. Trust and security model

The design separates three concerns.

## 5.1 Host containment

Host containment limits what the agent and its commands can access on the local machine.

Version 1 uses:

* a temporary source workspace;
* no `.git` metadata in the agent workspace;
* native Codex or Claude security controls;
* explicit native-tool permissions;
* restrictions on spawned commands;
* protected file paths;
* scrubbed environments;
* no general project-command internet access;
* no cloud or production credentials;
* no Git push;
* no Docker socket.

Version 1 does not claim to provide an independent security boundary stronger than the security facilities offered by Codex and Claude.

Instead, it requires those facilities to pass an agent-driven security self-test before autonomous execution is enabled.

## 5.2 Model-provider confidentiality

Code read by Codex or Claude may be transmitted to the configured cloud model provider.

Native sandboxing does not prevent this.

Version 1 supports only:

```yaml
cloud_model_access: allowed
```

and:

```yaml
cloud_model_access: prohibited
```

### `allowed`

Codex or Claude may process repository contents needed for the task.

### `prohibited`

The repository cannot be executed by Version 1 because no local-model adapter exists yet.

Version 1 does not expose a `restricted` mode because path restrictions cannot guarantee that information will not leak indirectly through:

* test output;
* compiler errors;
* stack traces;
* generated files;
* public interfaces;
* behavior of allowed modules.

Protected paths remain useful for preventing direct access to secrets and private data, but they are not presented as a complete information-flow guarantee.

## 5.3 External side effects

External operations are controlled separately.

Examples:

* writing to an external API;
* pushing Git changes;
* deploying an application;
* applying a remote migration;
* creating cloud resources;
* deleting remote data.

These require explicit plan capabilities and usually a high-risk review.

Version 1 does not perform autonomous production deployment.

---

# 6. Three security enforcement surfaces

A correct security policy must cover all three surfaces.

## 6.1 Agent-native tools

These are operations performed directly by Codex or Claude without invoking a shell.

Examples:

* Read;
* Grep;
* Glob;
* Edit;
* Write;
* WebFetch;
* web search;
* optional MCP tools.

Blocking a shell command such as:

```bash
cat ~/.ssh/id_rsa
```

does not necessarily block a native Read tool.

Therefore, native tool permissions must independently restrict:

* file reads;
* file writes;
* web access;
* optional tools.

## 6.2 Agent-spawned commands

These include:

```bash
npm test
python script.py
curl https://example.com
cat .env
```

Restrictions must apply to the complete child-process tree:

```text
Agent
└── shell
    └── npm
        └── Node.js
            └── project process
```

The policy must control:

* filesystem access;
* external network access;
* localhost access;
* environment variables;
* child processes;
* credentials.

## 6.3 Harness-owned operations

These are trusted operations initiated by deterministic code:

* repository export;
* documentation downloading;
* baseline verification;
* official RED/GREEN verification;
* file comparison;
* package installation;
* local-service lifecycle;
* Git staging;
* Git commits;
* artifact storage.

They do not execute arbitrary model-generated shell strings.

Commands are stored as argument arrays:

```ts
execa("npm", ["test", "--", "collector-runs"]);
```

The harness must never execute:

```ts
execaCommand(modelGeneratedString);
```

---

# 7. Agent security adapter

Each provider adapter implements a common contract.

```ts
interface AgentAdapter {
  compileSecurityPolicy(
    policy: SecurityPolicy,
  ): Promise<CompiledAgentPolicy>;

  runSecuritySelfTest(
    policy: CompiledAgentPolicy,
  ): Promise<SecuritySelfTestResult>;

  execute(
    input: AgentExecutionInput,
  ): Promise<AgentExecutionResult>;
}
```

The compiled provider policy must address:

* native file-reading tools;
* native file-writing tools;
* native web tools;
* spawned-command filesystem access;
* spawned-command network access;
* environment-variable scrubbing;
* provider-credential protection;
* unsandboxed fallback behavior.

For Claude, the generated configuration must require sandbox availability and disable unsandboxed retries.

Conceptually:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false
  }
}
```

The Codex adapter must similarly use a profile that restricts local command access to the temporary workspace and approved toolchain paths.

---

# 8. Security self-test

Security cannot be assumed merely because configuration was generated successfully.

The actual agent must attempt prohibited operations through both native tools and spawned commands.

Minimum self-test suite:

| Test                                   | Mechanism         | Expected result |
| -------------------------------------- | ----------------- | --------------- |
| Read protected file                    | Native Read       | Denied          |
| Read protected file                    | Shell             | Denied          |
| Write outside workspace                | Native Edit/Write | Denied          |
| Write outside workspace                | Shell             | Denied          |
| Write through an escaping symlink      | Shell             | Denied          |
| Fetch external URL                     | Native web tool   | Denied          |
| Fetch external URL                     | Shell             | Denied          |
| Read provider credential file          | Native Read       | Denied          |
| Read provider credential through shell | Shell             | Denied          |
| Read protected environment variable    | Shell             | Missing         |

Also run one positive test:

* read an allowed source file;
* write inside the temporary workspace;
* run an allowed local command.

The self-test runs:

* during initial harness setup;
* after the Codex CLI version changes;
* after the Claude CLI version changes;
* after the harness security-policy compiler changes;
* after the security-policy configuration changes.

It does not run before every step.

The result is cached by:

```text
provider
provider CLI version
operating system
harness version
security-policy hash
```

Autonomous execution is disabled when a required check fails.

---

# 9. Provider and project-command environments

The provider process and project commands need different environments.

## 9.1 Provider environment

The Codex or Claude process receives only what it needs:

* minimal `PATH`;
* locale;
* temporary directory;
* required subscription authentication;
* required provider configuration.

Remove by default:

```text
AWS_*
GCP_*
AZURE_*
DATABASE_URL
GITHUB_TOKEN
GH_TOKEN
NPM_TOKEN
SSH_AUTH_SOCK
KUBECONFIG
DOCKER_HOST
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

The OpenAI and Anthropic API keys are removed when subscription authentication is intended.

## 9.2 Project-command environment

Commands started by the agent receive an even smaller environment:

```text
PATH
LANG
TMPDIR
approved non-secret test variables
```

They must not receive:

* provider authentication;
* cloud credentials;
* SSH agent access;
* GitHub tokens;
* production database URLs;
* package publishing tokens.

The security self-test verifies this separation.

---

# 10. Repository and Git model

Git belongs exclusively to the harness.

The implementation agent does not receive a Git worktree and does not receive `.git` metadata.

## 10.1 Canonical plan branch

The harness owns one branch per plan:

```text
ai-harness/collector-dashboard
```

Only accepted step results are committed to this branch.

## 10.2 Plain agent workspace

For each step attempt, the harness exports the accepted commit into a plain directory:

```text
Canonical accepted commit
→ export source tree
→ temporary agent workspace without .git
```

Conceptually:

```bash
git archive <accepted-commit> | tar -x -C <workspace>
```

The workspace contains:

* project files;
* read-only harness context;
* local documentation bundles;
* no `.git`;
* no repository hooks;
* no repository-local Git configuration.

The agent cannot:

* commit;
* stage;
* reset;
* change branches;
* rewrite refs;
* change Git configuration;
* invoke hooks;
* push;
* modify previous accepted commits.

## 10.3 Filesystem result capture

After the agent finishes, the harness computes a complete tree difference between:

* the original exported source tree;
* the modified source tree.

The comparison includes:

* added files;
* modified files;
* deleted files;
* file modes;
* symlink targets;
* file sizes;
* file hashes.

## 10.4 Harness-owned acceptance

After validation and verification:

1. create a private harness staging worktree;
2. copy only approved changed files;
3. delete only approved removed files;
4. stage exact paths;
5. commit with hooks disabled;
6. add harness metadata trailers;
7. update SQLite.

Example:

```bash
git -c core.hooksPath=/dev/null commit \
  -m "feat(persist-collector-runs): persist collector executions"
```

Commit trailers:

```text
AI-Harness-Plan: collector-dashboard
AI-Harness-Step: persist-collector-runs
AI-Harness-Attempt: 2
AI-Harness-Idempotency-Key: 02ed...
```

The base branch is never modified automatically in Version 1.

---

# 11. Planning workflow

Planning occurs before autonomous execution.

```text
Repository analysis
→ preliminary plan analysis
→ documentation requirements
→ documentation acquisition
→ final executable plan
→ execution-manifest approval
```

## 11.1 Repository analysis

The planner inspects:

* architecture documents;
* relevant source files;
* tests;
* dependency manifests;
* local configuration;
* existing API integrations;
* existing operational conventions.

It identifies:

* source-of-truth boundaries;
* affected components;
* state transitions;
* persistence changes;
* external APIs;
* local services;
* error paths;
* migration requirements;
* risk and complexity.

## 11.2 Planning authorization for documentation

Downloading documentation happens before final plan approval.

Therefore, it uses a separate initialization authorization:

```yaml
planning:
  documentation:
    official_sources_only: true

    allowed_domains:
      - open-meteo.com
      - docs.example.com

    maximum_download_mb: 50
    executable_content: denied
```

Adding a new domain requires domain confirmation.

This authorization permits documentation acquisition only. It does not approve implementation.

## 11.3 Documentation manifest

The planner identifies required material:

```yaml
external_documentation:
  - id: open-meteo
    purpose: Forecast integration

    official_domains:
      - open-meteo.com

    required_topics:
      - forecast endpoint
      - hourly temperature
      - daily maximum temperature
      - timezone handling
      - error responses
      - rate limits

    maximum_age_days: 30
```

## 11.4 Documentation downloader

The deterministic downloader prefers:

1. OpenAPI or Swagger;
2. official `llms.txt`;
3. official API references;
4. official SDK documentation;
5. official examples;
6. official source repositories.

It:

* downloads only approved official domains;
* records source URLs;
* records timestamps and hashes;
* stores original content;
* converts relevant content to Markdown;
* strips active HTML and scripts;
* rejects executable files;
* limits total download size;
* builds a concise local index.

Downloaded documentation is treated as untrusted reference data.

Documentation text cannot redefine:

* harness policy;
* system instructions;
* security rules;
* plan constraints.

## 11.5 Local documentation bundle

```text
.ai-context/
└── external-apis/
    └── open-meteo/
        ├── manifest.yml
        ├── index.md
        ├── openapi.json
        ├── endpoints/
        └── examples/
```

## 11.6 Final plan construction

The final plan is created only after the planner reads the documentation bundle.

This reduces incorrect assumptions about:

* authentication;
* pagination;
* idempotency;
* rate limits;
* response schemas;
* error behavior;
* API versions.

## 11.7 Execution-time behavior

During implementation:

```text
Agent workspace              read-write
Documentation bundle         read-only
General project internet     disabled
```

Live external API access is allowed only in an explicitly declared integration-verification phase.

---

# 12. Executable plan

The design uses:

```text
plan.md                   Human-readable plan
plan.yml                  Machine-executable plan
execution-manifest.yml    Approved execution envelope
state.db                  Mutable runtime state
```

## 12.1 Plan contents

Every step declares:

* identifier;
* title;
* step type;
* observable behavior;
* dependencies;
* complexity;
* risk;
* allowed paths;
* test expectations;
* verification commands;
* documentation bundles;
* external capabilities;
* review requirements.

Example:

```yaml
version: 1

plan:
  id: collector-dashboard
  title: Add collector-monitoring dashboard

  execution:
    mode: autonomous
    backend: native

  security:
    repository_trust: trusted
    cloud_model_access: allowed

  review:
    read_code_after_finish: true
    high_risk_steps: required

  final_verification:
    commands:
      - [npm, test]
      - [npm, run, typecheck]
      - [npm, run, lint]

steps:
  - id: persist-collector-runs
    title: Persist collector executions
    type: code_behavior
    complexity: medium
    risk: normal

    behavior: >
      Every completed collector execution creates a persisted run
      containing its status, start time, finish time and error.

    depends_on: []

    test_phase:
      allowed_paths:
        - tests/collectors/**
        - tests/helpers/**

      command:
        - npm
        - test
        - --
        - collector-runs
        - --reporter=junit

      result_parser: junit

      expected_new_test_ids:
        - creates-running-collector-record
        - completes-successful-collector-record
        - records-collector-error

    implementation_phase:
      allowed_paths:
        - src/collectors/**
        - src/repositories/**

    verification:
      commands:
        - [npm, test, --, collector-runs, --reporter=junit]
        - [npm, run, typecheck]
        - [npm, run, lint]
```

---

# 13. Execution manifest

Approving only `plan.yml` is insufficient.

The user approves a compiled execution manifest.

```yaml
execution_manifest:
  version: 1

  repository:
    canonical_path: /projects/weather-data
    base_branch: main
    base_commit: abc123

  inputs:
    plan_hash: sha256:...
    project_config_hash: sha256:...
    documentation_manifest_hash: sha256:...
    command_registry_hash: sha256:...
    security_policy_hash: sha256:...
    routing_config_hash: sha256:...

  runtime:
    harness_version: 0.1.0
```

The manifest covers all semantic inputs that determine what may execute.

## 13.1 Changes requiring approval

* plan changes;
* verification-command changes;
* capability expansion;
* protected-path removal;
* documentation-source changes;
* security-policy broadening;
* routing-policy changes;
* different base commit before plan execution;
* new external side effects.

## 13.2 Changes not requiring approval

* retrying a failed attempt;
* rerunning verification;
* narrowing capabilities;
* restarting after interruption;
* refreshing logs;
* selecting a model through already-approved routing rules.

A Codex or Claude CLI version change invalidates the cached security self-test but does not necessarily require approval.

---

# 14. Step types

Version 1 supports three types.

## 14.1 `code_behavior`

Used when application behavior changes.

```text
Baseline verification
→ write tests
→ intended RED verification
→ freeze all non-implementation files
→ implement
→ GREEN verification
→ automatic review
→ acceptance
```

## 14.2 `operational`

Used for local operational changes that can be verified without Docker.

Examples:

* local application startup;
* process configuration;
* local scripts;
* static configuration;
* documentation;
* a local health endpoint;
* local mock services.

```text
Baseline verification
→ implement
→ static validation
→ startup or behavioral verification
→ automatic review
→ acceptance
```

## 14.3 `mixed`

Used only when one atomic observable behavior genuinely requires application and operational changes.

Example:

> The dashboard health endpoint is implemented and accessible through the supported local startup command.

Flow:

```text
Baseline verification
→ write code tests
→ verify RED
→ freeze non-implementation files
→ implement code and declared operational files
→ code verification
→ local startup
→ behavioral smoke test
→ automatic review
→ acceptance
```

The planner should prefer separate steps when each step independently introduces meaningful behavior and leaves the project working.

---

# 15. Code-step execution

## 15.1 Preparation

The harness:

1. validates the execution manifest;
2. checks completed dependencies;
3. selects an approved agent profile;
4. exports the latest accepted commit;
5. creates the plain temporary workspace;
6. mounts or copies read-only context;
7. starts a new attempt;
8. runs baseline verification.

## 15.2 Baseline verification

Before tests are added, the existing relevant tests must pass.

This distinguishes newly introduced failures from pre-existing failures.

The baseline result is saved as an artifact.

If baseline verification fails, the step stops:

```text
blocked_baseline_failure
```

The system must not interpret an already-broken repository as valid RED.

## 15.3 Test-writing phase

The agent receives a narrow prompt:

```text
Write tests for step persist-collector-runs.

Observable behavior:
Every collector execution creates a persisted run containing
its status, start time, finish time and error.

Expected test IDs:
- creates-running-collector-record
- completes-successful-collector-record
- records-collector-error

Allowed paths:
- tests/collectors/**
- tests/helpers/**

Do not modify implementation files.
Do not implement the behavior.
Stop after writing the tests.
```

After execution, the harness validates changed paths.

## 15.4 Intended RED verification

A valid RED result requires:

* the expected new tests were discovered;
* at least one expected new test failed;
* the failure is an assertion or intended behavioral failure;
* unrelated baseline tests did not newly fail;
* expected tests were not skipped;
* the test runner completed normally;
* no syntax or configuration failure replaced the intended failure.

Structured reporters are required for autonomous code steps.

Initially supported formats may include:

* JUnit XML;
* Vitest JSON;
* Jest JSON;
* Pytest JUnit XML.

A project without a supported structured test result parser can run only in supervised mode until an adapter exists.

## 15.5 Freeze policy

After valid RED:

> Only `implementation_phase.allowed_paths` may change.

Everything else is immutable.

This protects:

* tests;
* fixtures;
* snapshots;
* test helpers;
* package manifests;
* lockfiles;
* compiler configuration;
* test configuration;
* aliases;
* environment templates;
* setup files;
* unrelated source modules.

The harness records a tree manifest before implementation.

## 15.6 Implementation phase

The agent receives:

```text
Implement step persist-collector-runs.

The expected tests have been added and failed for the intended reason.

Only these paths may change:
- src/collectors/**
- src/repositories/**

Everything else is immutable.

Implement only the observable behavior of this step.
```

## 15.7 GREEN verification

The harness:

* compares the complete filesystem manifest;
* rejects changes outside implementation paths;
* confirms all frozen files remain identical;
* runs focused tests;
* runs declared type checking;
* runs declared linting;
* runs any additional verification;
* scans for accidental credential files;
* records all results.

The agent does not select the official verification commands.

## 15.8 Automatic review

A separate read-only agent may inspect:

* step specification;
* test diff;
* implementation diff;
* architecture context;
* verification output.

It returns structured findings:

```yaml
result: pass

scope_match: true
test_coverage: sufficient

findings:
  critical: []
  warnings:
    - The error conversion duplicates an existing helper.
```

Critical findings stop acceptance.

Warnings are retained for final review.

## 15.9 Acceptance

For a normal-risk step:

```text
Deterministic verification passes
+ no critical review finding
→ harness commits accepted files
→ workspace is removed
→ next step begins automatically
```

---

# 16. Operational and mixed-step verification

Version 1 is completely Docker-free.

Supported verification uses:

* normal local processes;
* temporary directories;
* SQLite;
* local mock HTTP servers;
* project test servers;
* already-installed local tools;
* harness-owned process commands.

## 16.1 Operational verification levels

### Static

Examples:

* configuration parses;
* schema validates;
* referenced files exist;
* expected scripts exist.

### Startup

Includes static checks plus:

* process starts;
* process stays alive;
* health endpoint responds.

### Behavioral

Includes startup plus an observable result:

* HTTP endpoint returns expected data;
* worker processes a test input;
* collector writes a test record;
* local script produces expected output.

### Recovery

Includes behavioral checks plus:

* process restart;
* temporary dependency failure;
* reconnect;
* retry behavior.

## 16.2 Harness-owned local-service profiles

A project may declare local process profiles:

```yaml
services:
  dashboard:
    start:
      - npm
      - run
      - dev

    health:
      url: http://127.0.0.1:3000/health
      expected_status: 200
      timeout_seconds: 30

    stop_signal: SIGTERM
```

The profile is included in the approved command registry.

The agent may request the named profile but may not create arbitrary host commands.

## 16.3 Unsupported infrastructure

A step requiring:

* Docker;
* Docker Compose;
* Kubernetes;
* a VM;
* privileged host operations;

is blocked in Version 1.

It must not be marked verified using static validation alone.

---

# 17. Dependency handling

Version 1 supports limited dependency changes.

## 17.1 Dependencies declared during planning

Expected dependency changes are part of the plan:

```yaml
dependency_changes:
  - manager: npm
    package: recharts
    version: 3.1.0
```

They are included in the execution manifest.

## 17.2 Harness-owned installation

The project configuration declares a trusted installation command:

```yaml
dependencies:
  install_command:
    - npm
    - install
    - --ignore-scripts

  allowed_registry:
    - https://registry.npmjs.org

  lifecycle_scripts: denied
```

Installation runs with:

* minimal environment;
* no provider credentials;
* no cloud credentials;
* no SSH agent;
* no Git metadata;
* approved registry access only where technically enforceable;
* lifecycle scripts disabled.

## 17.3 Lifecycle scripts

If a required dependency cannot install without lifecycle scripts, the harness stops for approval.

Version 1 does not attempt to automatically determine whether an arbitrary lifecycle script is safe.

## 17.4 Unexpected dependency changes

If implementation changes package manifests unexpectedly:

```text
repair_requested
```

The system does not install the dependency silently.

---

# 18. Model and effort routing

The harness uses subscription-authenticated Codex CLI and Claude Code.

No model API integration is required.

## 18.1 Agent profiles

```yaml
agents:
  profiles:
    codex-fast:
      adapter: codex-cli
      model: configured-fast-model
      effort: medium
      timeout_seconds: 600

    codex-deep:
      adapter: codex-cli
      model: configured-strong-model
      effort: high
      timeout_seconds: 1800

    claude-balanced:
      adapter: claude-code
      model: configured-balanced-model
      effort: high
      timeout_seconds: 1200

    claude-deep:
      adapter: claude-code
      model: configured-strong-model
      effort: maximum-supported
      timeout_seconds: 2400
```

Model names remain configuration because available models change.

## 18.2 Step classification

Each step contains:

```yaml
complexity: low | medium | high
risk: normal | high
```

Complexity represents implementation difficulty.

Risk represents the consequence of an incorrect result.

## 18.3 Phase-specific routing

Different phases may use different profiles.

```yaml
routing:
  defaults:
    planning: claude-deep
    plan_review: claude-deep
    test_writing: codex-fast
    implementation: codex-fast
    failure_diagnosis: codex-deep
    code_review: claude-balanced
```

## 18.4 Deterministic rules

```yaml
routing:
  rules:
    - when:
        complexity: low
        risk: normal
      implementation: codex-fast

    - when:
        complexity: medium
      implementation: codex-deep

    - when:
        complexity: high
      implementation: claude-deep

    - when:
        risk: high
      minimum_profile: codex-deep
```

The model does not select itself.

## 18.5 Escalation

```yaml
routing:
  escalation:
    codex-fast: codex-deep
    codex-deep: claude-deep
    claude-balanced: claude-deep
    claude-deep: stop
```

Default retry behavior:

```text
Selected profile attempt
→ verification failure
→ failure diagnosis
→ one stronger attempt
→ human intervention if still failing
```

All routing choices and results are recorded for future evaluation.

---

# 19. Human review policy

Version 1 uses two settings:

```yaml
review:
  read_code_after_finish: true
  high_risk_steps: required
```

## 19.1 Final code review

### `read_code_after_finish: true`

After final verification, the harness pauses and presents:

* complete diff;
* commits grouped by plan step;
* test results;
* automatic-review warnings;
* plan repairs;
* external integration results;
* unresolved issues.

The branch is not merged automatically.

### `read_code_after_finish: false`

The plan is marked complete after final verification.

The branch and artifacts remain available.

## 19.2 High-risk review

### `high_risk_steps: required`

Pause after steps marked `risk: high`.

Typical high-risk steps:

* authentication;
* authorization;
* financial calculations;
* destructive operations;
* database migrations;
* concurrency guarantees;
* external writes;
* secret handling;
* deployment permissions.

### `high_risk_steps: not_required`

High-risk steps proceed after automated verification.

## 19.3 Recommended defaults

```yaml
review:
  read_code_after_finish: true
  high_risk_steps: required
```

---

# 20. Plan repair

Plans are expected to evolve during execution.

A step may reveal:

* a false architectural assumption;
* a missing prerequisite;
* incorrect step ordering;
* an obsolete future step;
* an undocumented API constraint;
* the need to compensate for an earlier accepted change.

## 20.1 Repair flow

```text
Current attempt discovers plan problem
→ stop current attempt
→ planner proposes amendment
→ user reviews amendment
→ plan revision increases
→ execution resumes
```

## 20.2 Amendment format

```yaml
plan_amendment:
  base_plan_revision: 3

  reason: >
    The status API requires aggregated collector state before
    the endpoint can be implemented.

  changes:
    - action: insert_before
      target: add-status-api

      step:
        id: aggregate-collector-status
        type: code_behavior
        complexity: medium
        risk: normal

    - action: modify
      target: add-status-api

      changes:
        depends_on:
          - aggregate-collector-status
```

The amendment explains:

* why the original plan is insufficient;
* which completed steps are affected;
* which future steps change;
* whether new documentation is needed;
* whether new capabilities are needed;
* whether previous verification remains valid.

## 20.3 Completed history

Accepted commits are not silently rewritten.

When an earlier accepted behavior must change, the amended plan adds a compensating step.

```text
Accepted historical step
→ compensating correction step
→ revised future plan
```

## 20.4 Approval

Plan repair is a human gate in Version 1.

The user approves only the amendment and its updated execution-manifest fields.

---

# 21. Test-contract repair

If implementation reveals that tests or test infrastructure must change:

```text
blocked_test_contract_change
```

The agent reports:

* the required change;
* affected files;
* why the original test phase was insufficient;
* why implementation cannot continue.

The current implementation attempt is discarded.

After approval:

```text
Return to test phase
→ revise test contract
→ establish intended RED again
→ freeze workspace again
→ restart implementation
```

The implementation agent may never weaken the active test contract to make its code pass.

---

# 22. Capability escalation

The agent cannot broaden its own permissions.

It may return:

```yaml
status: blocked

required_capability:
  type: external_domain
  value: api.example.com

reason: >
  The local documentation does not include the required schema.
```

Capability categories include:

* new documentation domain;
* live external API access;
* additional repository path;
* dependency change;
* lifecycle script;
* local service;
* external credential;
* external write;
* unsupported Docker backend.

The harness:

* resolves the request through a predefined safe workflow;
* proposes plan repair;
* or requests user approval.

---

# 23. Persistent state

Use SQLite.

Enable:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

## 23.1 Plan states

```text
draft
approved
running
repair_requested
awaiting_repair_approval
awaiting_final_review
completed
changed_requires_reapproval
failed
cancelled
```

## 23.2 Attempt states

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

Exceptional states:

```text
blocked
repair_requested
failed
interrupted
rejected
cancelled
```

The `accepting` state is important because a crash may happen between:

* committing accepted files;
* updating SQLite.

## 23.3 Main tables

### `plans`

```text
id
repository_id
title
revision
plan_path
manifest_hash
state
branch_name
base_commit
created_at
updated_at
```

### `steps`

```text
id
plan_id
position
type
title
behavior
complexity
risk
state
accepted_attempt_id
created_at
updated_at
```

### `attempts`

```text
id
step_id
number
profile_id
state
base_commit
red_artifact
accepted_commit
failure_category
failure_message
started_at
finished_at
```

### `events`

```text
id
sequence
idempotency_key
repository_id
plan_id
plan_revision
step_id
attempt_id
event_type
payload_json
created_at
```

### `command_runs`

```text
id
attempt_id
phase
argv_json
exit_code
termination_reason
duration_ms
stdout_artifact
stderr_artifact
created_at
```

### `reviews`

```text
id
step_id
attempt_id
reviewer_profile
result
findings_json
created_at
```

### `approvals`

```text
id
plan_id
step_id
attempt_id
decision
reason
actor
created_at
```

---

# 24. Crash recovery and reconciliation

State is persisted at phase boundaries.

On startup, the harness reconciles:

* SQLite state;
* canonical plan branch;
* commit trailers;
* temporary workspace existence;
* artifact completeness.

Example:

```text
Commit exists with expected idempotency key
+ SQLite still says accepting
→ finish SQLite transition
→ do not rerun implementation
```

If execution was interrupted before acceptance:

* archive incomplete artifacts;
* remove the temporary workspace;
* recreate the workspace from the latest accepted commit;
* resume from the last completed deterministic phase.

The harness must not delete an interrupted workspace before checking whether a valid accepted commit was already created.

---

# 25. Artifacts and events

Every attempt stores:

```text
artifacts/
└── <plan-id>/
    └── <step-id>/
        └── <attempt-id>/
            ├── prompts/
            ├── agent-output/
            ├── commands/
            ├── tests/
            ├── review/
            ├── source-diff.patch
            ├── changed-files.json
            ├── frozen-tree.json
            ├── security-policy.yml
            └── summary.json
```

Artifacts include:

* prompts;
* model and effort;
* agent output;
* baseline results;
* RED results;
* GREEN results;
* source diff;
* changed paths;
* filesystem hashes;
* security policy;
* documentation bundle references;
* duration;
* failure classification;
* reviewer findings;
* repair requests.

---

# 26. CLI

## Project setup

```bash
ai-harness init
ai-harness config validate
ai-harness security test
```

## Planning

```bash
ai-harness plan analyze
ai-harness docs fetch
ai-harness plan build
ai-harness plan validate
ai-harness plan approve
ai-harness plan show
```

## Execution

```bash
ai-harness run
ai-harness pause
ai-harness resume
ai-harness cancel
```

`run` proceeds automatically until:

* completion;
* high-risk review;
* plan repair;
* capability escalation;
* repeated failure;
* final review.

## Inspection

```bash
ai-harness status
ai-harness step show
ai-harness diff
ai-harness diff --step <step-id>
ai-harness logs
ai-harness events
ai-harness artifacts
```

## Review and repair

```bash
ai-harness approve
ai-harness reject --reason "..."
ai-harness repair show
ai-harness repair approve
ai-harness repair reject
```

---

# 27. Suggested code structure

```text
src/
├── cli/
├── config/
├── plans/
│   ├── schema.ts
│   ├── loader.ts
│   ├── validator.ts
│   ├── compiler.ts
│   ├── manifest.ts
│   └── repair.ts
├── documentation/
│   ├── manifest.ts
│   ├── downloader.ts
│   ├── sanitizer.ts
│   └── index-builder.ts
├── orchestration/
│   ├── orchestrator.ts
│   ├── state-machine.ts
│   ├── policy-engine.ts
│   ├── capability-policy.ts
│   └── risk-policy.ts
├── execution/
│   ├── code-step-runner.ts
│   ├── operational-step-runner.ts
│   ├── mixed-step-runner.ts
│   ├── baseline-runner.ts
│   ├── red-verifier.ts
│   ├── green-verifier.ts
│   └── review-runner.ts
├── adapters/
│   ├── agents/
│   │   ├── agent-adapter.ts
│   │   ├── codex-cli-adapter.ts
│   │   └── claude-code-adapter.ts
│   ├── test-results/
│   │   ├── junit-parser.ts
│   │   ├── vitest-parser.ts
│   │   └── jest-parser.ts
│   ├── git/
│   │   ├── repository-exporter.ts
│   │   └── git-acceptance-manager.ts
│   └── process/
│       └── command-runner.ts
├── routing/
├── storage/
├── events/
├── metrics/
└── artifacts/
```

Suggested stack:

```text
Language:       TypeScript
Runtime:        Node.js 22+
CLI:            Commander
Validation:     Zod
YAML:           yaml
Database:       better-sqlite3
Processes:      execa
Glob matching:  minimatch
Logging:        pino
Tests:          Vitest
```

---

# 28. Future cost accounting

Cost accounting is not required to control Version 1, but Version 1 must preserve the necessary data.

For every AI invocation, record:

```text
provider
adapter
model
effort
phase
start time
finish time
duration
input tokens when available
cached tokens when available
output tokens when available
tool calls when available
attempt number
usage source
exact cost when available
estimated cost when possible
```

Cost confidence:

```text
exact
provider_reported
estimated
unknown
```

Future derived metrics:

```text
cost_per_successful_step
cost_per_completed_plan
failed_attempt_cost
review_cost
repair_cost
cost_by_model
cost_by_step_type
```

Subscription usage estimates must never be represented as exact monetary costs.

---

# 29. Future metrics and aggregation

The event model must support aggregation by:

* repository;
* plan;
* plan revision;
* step;
* attempt;
* phase;
* provider;
* model;
* effort;
* complexity;
* risk;
* step type;
* time period.

Future quality metrics:

```text
plan_completion_rate
step_success_rate
first_attempt_success_rate
mean_attempts_per_step
time_to_verified_step
time_to_completed_plan
human_interruption_rate
scope_violation_rate
test_contract_change_rate
plan_repair_rate
verification_failure_rate
automatic_review_rejection_rate
recovery_success_rate
```

Security metrics:

```text
security_self_test_failures
blocked_native_tool_operations
blocked_spawned_command_operations
credential_isolation_failures
capability_escalations
```

Documentation metrics:

```text
documentation_bundle_age
documentation_fetch_failures
missing_documentation_requests
execution_time_external_requests
```

Routing metrics:

```text
success_rate_by_model
success_rate_by_effort
success_rate_by_complexity
escalation_rate
cost_vs_success
latency_vs_success
```

Lines of code, token volume and tool-call count are not quality metrics by themselves.

---

# 30. Future feedback loop

Capture structured feedback:

* plan rejection reason;
* amendment reason;
* step rejection reason;
* manual corrections after completion;
* false-positive reviewer findings;
* missed defects;
* routing overrides;
* accepted warnings;
* capability decisions.

Example:

```yaml
feedback:
  category: architecture_error
  phase: implementation
  step_id: add-status-api

  summary: >
    The implementation bypassed the repository abstraction.

  resolution:
    - revise_plan
    - add_architecture_context
```

Future improvement cycle:

```text
Execution trace
→ failure or human feedback
→ classify cause
→ create evaluation case
→ change prompt, routing or policy
→ run regression suite
→ compare metrics
→ accept or reject change
```

Failure categories should distinguish:

* plan failure;
* missing context;
* documentation failure;
* model reasoning failure;
* implementation failure;
* verification weakness;
* security-policy failure;
* runtime failure;
* routing failure;
* ambiguous requirement.

The harness must not rewrite its own default policies based on a single feedback item.

---

# 31. Future dashboard

A future dashboard will be a read-only interface over:

* plans;
* executions;
* events;
* artifacts;
* reviews;
* metrics;
* costs;
* feedback.

It will not be part of the trusted execution boundary.

Suggested sections:

## Active execution

* current plan;
* current step;
* current phase;
* elapsed time;
* model and effort;
* current interruption;
* capability request.

## Quality

* completion rate;
* first-attempt success;
* verification failures;
* plan repairs;
* human rejections;
* reviewer findings.

## Cost and performance

* exact or estimated cost;
* duration by phase;
* failed-attempt cost;
* escalation frequency;
* model comparison.

## Plan inspection

* plan revisions;
* accepted commits;
* step diffs;
* final diff;
* test results;
* documentation bundles;
* repair history.

## Feedback

* rejection reasons;
* manual corrections;
* unresolved warnings;
* evaluation cases.

The CLI and execution engine must continue to function independently of the dashboard.

---

# 32. Milestone strategy

The following milestones are product increments, not detailed implementation steps.

Each milestone must:

* produce a working usable system;
* remain internally coherent;
* provide meaningful new capability;
* preserve existing behavior;
* be suitable for expansion into its own implementation plan.

---

# Milestone 1 — Safe Single-Task Agent Runner

## Goal

Run one coding task safely in a trusted repository using one provider.

Recommended first provider: Codex CLI.

## Included functionality

* TypeScript CLI;
* project initialization;
* trusted-repository declaration;
* `cloud_model_access: allowed`;
* protected paths;
* provider and project-command environment separation;
* security-policy compilation;
* agent-driven security self-test;
* repository export into a plain workspace without `.git`;
* one manually supplied task;
* one configured verification command set;
* changed-file inspection;
* harness-owned Git commit;
* artifact storage.

## User flow

```bash
ai-harness init
ai-harness security test
ai-harness task run task.md
ai-harness diff
ai-harness task accept
```

## Working result

The user can give Codex one implementation task, allow it to run without per-command approval, inspect a verified diff and commit it through the harness.

## Significant improvement over the current workflow

* no agent Git access;
* explicit security verification;
* protected credentials;
* reproducible artifacts;
* harness-controlled acceptance.

## Deliberately excluded

* plans;
* multiple steps;
* TDD enforcement;
* persistence across multiple steps;
* Claude support;
* model routing.

---

# Milestone 2 — Executable Single Code Step

## Goal

Execute one structured code-behavior step using enforced tests-first behavior.

## Added functionality

* YAML step schema;
* observable behavior;
* allowed test paths;
* allowed implementation paths;
* baseline verification;
* structured test-result parsing;
* expected test IDs;
* intended RED validation;
* freeze-all-except-implementation policy;
* GREEN verification;
* automatic source-tree comparison;
* one accepted test commit and implementation commit.

## User flow

```bash
ai-harness step validate step.yml
ai-harness step approve
ai-harness step run
ai-harness step diff
ai-harness step accept
```

## Working result

The harness can autonomously:

1. verify the repository baseline;
2. ask the agent to write tests;
3. confirm those exact tests fail for the intended reason;
4. freeze the verification contract;
5. ask the agent to implement;
6. reject unrelated or test changes;
7. verify GREEN;
8. produce reviewable commits.

## Significant improvement over Milestone 1

The tool now enforces implementation quality rather than merely running an agent and executing tests afterward.

---

# Milestone 3 — Autonomous Multi-Step Plans

## Goal

Execute a complete approved plan rather than one isolated step.

## Added functionality

* full `plan.yml`;
* step dependencies;
* plan branch;
* execution manifest;
* plan approval;
* persistent SQLite state;
* autonomous transition between normal steps;
* one fresh workspace per step;
* crash recovery;
* acceptance idempotency;
* final verification;
* `read_code_after_finish`;
* basic plan status CLI.

## User flow

```bash
ai-harness plan validate
ai-harness plan approve
ai-harness run
ai-harness status
ai-harness resume
```

## Working result

A normal multi-step implementation plan can run unattended until:

* completion;
* verification failure;
* final review.

## Significant improvement over Milestone 2

This is the first version that provides materially more automation than manually invoking `plan-step` for every step.

---

# Milestone 4 — Claude Support and Model Routing

## Goal

Use both Codex CLI and Claude Code and select them by phase and task complexity.

## Added functionality

* Claude adapter;
* Claude-native tool and command security policy;
* Claude agent-driven security self-test;
* reusable agent profiles;
* complexity and risk classification;
* phase-specific routing;
* manual step-level profile override;
* one deterministic stronger-model retry;
* failure-diagnosis phase;
* model, effort and duration recording.

## Working result

Different tasks can automatically use:

* a faster profile for straightforward test writing;
* a stronger profile for complex implementation;
* another profile for review or failure diagnosis.

## Significant improvement over Milestone 3

The harness now optimizes quality and usage rather than using one coding agent and one effort level for all work.

---

# Milestone 5 — Automatic Review and Risk Gates

## Goal

Increase autonomy while keeping human attention focused on consequential changes.

## Added functionality

* read-only reviewer-agent phase;
* structured critical findings and warnings;
* `risk: normal | high`;
* `high_risk_steps: required | not_required`;
* `read_code_after_finish: true | false`;
* final combined review report;
* rejection reason capture;
* retry after rejection.

## Working result

Normal verified steps advance automatically.

High-risk steps and final code review pause only according to configuration.

## Significant improvement over Milestone 4

The harness can run longer plans with limited supervision while still applying independent AI review and targeted human gates.

---

# Milestone 6 — Operational and Mixed Steps Without Docker

## Goal

Support complete local application features, not only pure code behavior.

## Added functionality

* `operational` step type;
* `mixed` step type;
* harness-owned local process profiles;
* static validation;
* local startup verification;
* HTTP health checks;
* behavioral smoke tests;
* process teardown;
* recovery checks where configured;
* unsupported-capability reporting for Docker requirements.

## Working result

The harness can implement and verify features such as:

* a dashboard server;
* a local API;
* a background worker;
* a health endpoint;
* configuration and startup scripts;

without requiring Docker or Kubernetes.

## Significant improvement over Milestone 5

The harness can now execute end-to-end feature plans instead of only source-code logic.

---

# Milestone 7 — External API Documentation Workflow

## Goal

Implement external API integrations with minimal execution-time internet access.

## Added functionality

* planning-time domain authorization;
* documentation requirement detection;
* official documentation downloader;
* provenance and hash storage;
* HTML sanitization;
* local Markdown and OpenAPI bundles;
* documentation index;
* documentation freshness checks;
* read-only documentation context during execution;
* limited declared live API verification;
* external-request artifacts.

## Working result

The planner can discover and download required API documentation before finalizing the plan, while implementation agents normally work offline using local documentation.

## Significant improvement over Milestone 6

The harness can reliably implement common external API integrations without allowing every implementation session to browse the internet.

---

# Milestone 8 — Plan Repair and Capability Escalation

## Goal

Allow long-running plans to adapt when implementation reveals incorrect assumptions.

## Added functionality

* `repair_requested`;
* structured plan amendments;
* plan revisions;
* insertion, modification and removal of future steps;
* compensating steps for accepted history;
* test-contract repair flow;
* capability requests;
* domain, dependency and local-service escalation;
* amendment-only approval;
* repair metrics.

## Working result

A plan no longer needs to be abandoned when a later step reveals that an earlier assumption was wrong.

## Significant improvement over Milestone 7

The harness becomes practical for real projects where implementation plans inevitably evolve.

---

# Milestone 9 — Metrics, Cost and Feedback Foundation

## Goal

Make harness quality measurable and prepare for systematic improvement.

## Added functionality

* structured usage records;
* exact/provider-reported/estimated/unknown cost classification;
* success and failure metrics;
* routing metrics;
* security metrics;
* documentation metrics;
* structured human feedback;
* failure taxonomy;
* evaluation-case export;
* aggregate queries over SQLite.

## Working result

The user can answer:

* Which model works best for medium-complexity steps?
* How often does the planner require repair?
* What proportion succeeds on the first attempt?
* How much time is spent in verification?
* Which failures come from the model versus the harness?
* How often is human intervention required?

## Significant improvement over Milestone 8

The harness becomes an evidence-driven engineering system rather than only an execution tool.

---

# Milestone 10 — Read-Only Dashboard

## Goal

Provide a visual interface for monitoring and improving the harness.

## Added functionality

* active plan view;
* current step and phase;
* event timeline;
* diff and artifact viewer;
* cost and duration summaries;
* model comparison;
* failure categories;
* plan-repair history;
* review findings;
* feedback inspection.

## Working result

The CLI remains authoritative, but executions and historical performance can be inspected visually.

## Significant improvement over Milestone 9

The system becomes easier to operate, demonstrate in a portfolio and analyze across many plans.

---

# 33. Post-Version 1 direction

Docker and OpenHands are not part of the milestones above unless explicitly moved into Version 2.

Possible Version 2 additions:

```text
Docker execution backend
OpenHands execution adapter
remote workers
parallel steps
CI integration
untrusted-repository mode
resource limits
local-model adapter
MCP interface
Web-based approvals
```

The custom harness remains authoritative for:

* executable plans;
* state transitions;
* test integrity;
* Git acceptance;
* routing;
* repairs;
* reviews;
* metrics.

Docker or OpenHands would provide an alternative runtime, not replace the plan-execution product.

---

# 34. Recommended Version 1 defaults

```yaml
version: 1

execution:
  backend: native
  mode: autonomous
  workspace_per_step: true
  expose_git_metadata_to_agent: false

security:
  repository_trust: trusted
  cloud_model_access: allowed
  require_agent_self_test: true

review:
  read_code_after_finish: true
  high_risk_steps: required

planning:
  documentation:
    official_sources_only: true

dependencies:
  lifecycle_scripts: denied
  unexpected_changes: repair_required

infrastructure:
  docker_supported: false
  kubernetes_supported: false
  local_processes_supported: true

routing:
  deterministic: true
  stronger_retry_attempts: 1

future:
  docker_backend: version_2
  openhands_backend: version_2
  dashboard: later
```

The intended final Version 1 behavior is:

```text
Trusted repository
→ security self-test
→ documentation-aware plan
→ execution-manifest approval
→ autonomous native-agent execution
→ structured RED/GREEN gates
→ harness-owned Git commits
→ automatic step progression
→ repair and risk interruptions only when needed
→ optional final code review
→ reviewable plan branch
```
