# Task Board demo

This demo runs the published two-step plan against a fresh copy of `demo/repo`.

## Replay

Prerequisites:

- Docker or OrbStack;
- Node.js 22.13 or later;
- dependencies installed with `npm ci`;
- runtime images built with `npm run images:build`.

Run:

```sh
npm run demo
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
tour print their locations. Remove them when you no longer need them.

## Live providers

First complete the Codex and Claude authentication steps in [`RUNBOOK.md`](../RUNBOOK.md). Then:

```sh
repo=$(mktemp -d)
cp -R demo/repo/. "$repo/"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=Demo -c user.email=demo@enactment.invalid \
  commit -q -m 'Initial task board'

node dist/cli.js prepare demo/plan.yml --repo "$repo" --output "$repo/manifest.yml"
node dist/cli.js run "$repo/manifest.yml" --repo "$repo" --artifacts "$repo/artifacts"
```

This uses the same frozen plan and project as the replay. It uses real Codex and Claude images and
provider credentials. A successful run creates `enactment/task-summary` with two commits.
