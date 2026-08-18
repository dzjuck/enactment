# Task Board demo

This demo runs the published two-step plan against a fresh copy of `demo/repo`.

## Recorded replay

Prerequisites:

- Docker or OrbStack;
- Node.js 22.13 or later;
- dependencies installed with `npm ci`;
- runtime images built with `npm run images:build`.

Run:

```sh
npm run demo:replay
```

The driver builds `enactment/demo-agent`. That image contains the recorded files in
`demo/answers/`. Its immutable image ID is recorded as the approved Codex and Claude image ID.
Changing an answer changes the image ID and invalidates an old approval.

The replay proves that the production command can prepare the plan, run both providers' control
paths, enforce RED and GREEN, perform static and runtime verification, review changes, create two
commits, and retain evidence. It does not prove that Codex or Claude can implement the plan. No
provider is called.

The driver creates placeholder Codex and Claude credential files. They contain invented text. They
only exercise credential mounts and the Claude launcher contract.

The first run needs the npm registry to install the demo project's dependencies. The cache is kept
under ignored `demo/.cache/deps`. The replay is credential-free, not offline.

The temporary repository, state database and artifacts are not deleted. Progress and the evidence
tour print their locations. The complete report remains under the printed
`artifacts/task-summary/reports/` path. Remove the temporary directory when you no longer need it.

Measured from a clean clone on the development host with `npm run demo:replay`: the first run took
31.29 seconds; the warm run took 27.14 seconds.

## Live providers

Prerequisites are the same runtime images and installed dependencies as replay, plus provider
subscriptions. Complete the Codex and Claude authentication steps in
[`RUNBOOK.md`](../RUNBOOK.md). Then run:

```sh
npm run demo
```

This uses the same frozen plan and project as the replay. It uses real Codex and Claude images and
provider credentials. It consumes provider quota, and results are nondeterministic. A successful
run creates `enactment/task-summary` with two commits.

The live driver keeps the repository, plan database and artifacts in a new temporary directory. It
uses the normal persistent Codex credential store and Claude token path. It does not copy secrets
into the temporary directory.

Both demo commands produce human-readable output. They do not dump the report as JSON. The complete
report remains under the printed `artifacts/task-summary/reports/` path. Direct `prepare` and `run`
commands are the lower-level machine interface and write JSON to stdout; see the
[`RUNBOOK.md`](../RUNBOOK.md).
