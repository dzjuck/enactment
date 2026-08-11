# M2 tests-first fixture

Minimal reusable repository and plan for a real two-agent RED → GREEN run.

Create a fresh repository for every run:

```sh
repo=$(mktemp -d /tmp/enactment-m2.XXXXXX)
artifacts=$(mktemp -d /tmp/enactment-m2-artifacts.XXXXXX)
cp -R fixtures/m2-repo/. "$repo/"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name='Harness Test' -c user.email='test@harness.invalid' \
  commit -q -m 'Initial fixture'

node dist/cli.js prepare "$repo/plan.yml" --repo "$repo" --output "$repo/execution-manifest.yml"
node dist/cli.js run "$repo/execution-manifest.yml" --repo "$repo" --artifacts "$artifacts"
```

Build the harness and runtime images first as described in `RUNBOOK.md`. A successful run creates
`src/slugify.js` and `test/slugify.test.js` on a harness-owned branch. Inspect the RED/GREEN evidence under
`$artifacts/m2-slugify/steps/add-slugify/<attempt>/run-1/` and the plan report under
`$artifacts/m2-slugify/reports/`.

To repeat the run, run the block again. Do not reuse the completed scratch repository.
