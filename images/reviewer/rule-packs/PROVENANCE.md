# Vendored review rule packs

These rules are copied verbatim from GitLab's SAST rule repository. They are vendored rather
than downloaded, so the reviewer container needs no network and the exact rule content is
covered by `reviewer_image_id` in the approved execution manifest.

| Field | Value |
| --- | --- |
| Repository | <https://gitlab.com/gitlab-org/security-products/sast-rules> |
| Commit | `d580dedc604363a7606bc0a7192f4edf3e675cae` |
| Vendored on | 2026-08-11 |
| Scanner | Semgrep CE 1.172.0 |

Enactment owns the selection, the pin, the packaging and the gate behavior. GitLab owns the
upstream rule text. Licenses are in `LICENSES/`; the subtree-to-license map is in
`THIRD_PARTY_NOTICES.md`.

## Layout

```text
javascript/
  gitlab-mit/<upstream path under `javascript/`>
  gitlab-lgpl/<upstream path under `rules/lgpl/javascript/`>
```

One directory per license, so a subtree names the terms its files are redistributed under. The
upstream path below that point is preserved, and each rule keeps its upstream header comment.
The image exposes the pack root as `/opt/enactment/rules`; Semgrep discovers rules recursively
from there, so a later Python pack lands at `python/gitlab-mit/` and changes no orchestration.

Each rule is accompanied by its upstream annotated rule-test fixture under the same stem
(`.js`, and `.ts` where upstream ships one). Those fixtures test the pack. They are not scan
targets: the reviewer scans only `/review`.

## Selected rules

MIT, from the upstream `javascript/` tree:

```text
javascript/buf/rule-buffer-noassert-read.yml
javascript/buf/rule-buffer-noassert-write.yml
javascript/dos/rule-non-literal-regexp.yml
javascript/eval/rule-eval-with-expression.yml
javascript/xss/rule-mustache-escape.yml
```

LGPL-3.0, from the upstream `rules/lgpl/javascript/` tree:

```text
rules/lgpl/javascript/crypto/rule-node_insecure_random_generator.yml
rules/lgpl/javascript/crypto/rule-node_tls_reject.yml
rules/lgpl/javascript/database/rule-node_knex_sqli_injection.yml
rules/lgpl/javascript/database/rule-node_nosqli_injection.yml
rules/lgpl/javascript/database/rule-node_sqli_injection.yml
rules/lgpl/javascript/eval/rule-eval_nodejs.yml
rules/lgpl/javascript/eval/rule-eval_require.yml
rules/lgpl/javascript/eval/rule-node_deserialize.yml
rules/lgpl/javascript/eval/rule-serializetojs_deserialize.yml
rules/lgpl/javascript/eval/rule-yaml_deserialize.yml
rules/lgpl/javascript/exec/rule-shelljs_os_command_exec.yml
rules/lgpl/javascript/jwt/rule-hardcoded_jwt_secret.yml
rules/lgpl/javascript/jwt/rule-node_jwt_none_algorithm.yml
rules/lgpl/javascript/traversal/rule-join_resolve_path_traversal.yml
rules/lgpl/javascript/xml/rule-node_xxe.yml
```

20 files, 20 rules. `test/hermetic/reviewer-contract.test.ts` asserts that list exactly, so an
addition is a test failure rather than a silent grow.

## Selection criteria

Included, for the shape of mistake an implementation agent makes in Node/JavaScript:
injection (SQL, NoSQL, command, XXE, template), unsafe deserialization and `eval`, path
traversal, JWT misuse, weak randomness and disabled TLS verification.

Excluded, and why:

- **framework packs** — Electron, React, Express headers, cookie-session, SSRF-via-browser.
  A step is reviewed for the mistake, not for framework conventions.
- **any rule declaring `paths:`** — review scans copies under `/review/before` and
  `/review/after`, and the prefix would defeat an include/exclude filter, silently changing
  what is reviewed. No selected rule declares one.
- **any `INFO`-severity rule** — warnings block high-risk steps, so a style finding must not be
  able to stop a plan. Every selected rule is `ERROR` or `WARNING`.
- **any rule without a positive upstream fixture** — an unproven rule is not a gate. Two
  otherwise-wanted MIT candidates were dropped on this criterion,
  `javascript/random/rule-pseudo-random-bytes.yml` and
  `javascript/require/rule-non-literal-require.yml`: their adjacent upstream `.js` files are
  `eslint-plugin-security` RuleTester scripts, not annotated Semgrep fixtures, so the pinned
  scanner reports no test at all for those rule IDs. Weak-random coverage is kept through the
  LGPL `rule-node_insecure_random_generator`, which has one. Upstream rules are never patched
  and fixtures are never authored here to close such a gap.

## Qualification

Against the pinned scanner, offline, with the pack mounted read-only:

```bash
semgrep --metrics=off --disable-version-check --test <pack>
```

Requires a passing positive test for every rule ID: measured 20 configs, 20 tested rules, no
config errors.

```bash
semgrep scan --validate --metrics=off --config <pack>
```

Requires every rule to load: measured 0 configuration errors, 20 rules. This command is the
one exception to the offline rule — it downloads the `p/semgrep-rule-lints` pack from
`semgrep.dev` — so it runs with network. Offline rule loading is what `--test` proves.

## Updating

Re-vendoring is a policy change: select the rules, copy them and their fixtures, review the
licenses, update the commit above, rebuild the reviewer image, and run `prepare` again so an
operator approves the new `reviewer_image_id`. There is no runtime rule download, no automatic
update and no per-plan rule selection.
