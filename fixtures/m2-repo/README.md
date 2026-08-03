# M2 tests-first fixture

Minimal reusable repository and plan for a real two-agent RED → GREEN run.

Create a fresh repository for every run:

```sh
repo=$(mktemp -d /tmp/ai-harness-m2.XXXXXX)
artifacts=$(mktemp -d /tmp/ai-harness-m2-artifacts.XXXXXX)
cp -R fixtures/m2-repo/. "$repo/"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name='Harness Test' -c user.email='test@harness.invalid' \
  commit -q -m 'Initial fixture'

node dist/cli.js run "$repo/plan.yml" --repo "$repo" --artifacts "$artifacts"
```

Build the harness and runtime images first as described in `RUNBOOK.md`. A successful run creates
`src/slugify.js` and `test/slugify.test.js` on a harness-owned branch. Inspect the RED/GREEN evidence
in `$artifacts/run-manifest.json` and the resulting commit printed by the command.

To repeat the run, run the block again. Do not reuse the completed scratch repository.
