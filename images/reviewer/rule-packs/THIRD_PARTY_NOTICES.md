# Third-party notices

Enactment is licensed under Apache-2.0 (see `LICENSE` at the repository root). The files under
this directory are **not** Enactment code. They are third-party Semgrep rules and their rule-test
fixtures, redistributed under their own terms.

## Subtree map

| Subtree | License | Full text | Copyright |
| --- | --- | --- | --- |
| `javascript/gitlab-mit/` | MIT (Expat) | `LICENSES/GitLab-MIT.txt` | GitLab Inc. and named upstream contributors |
| `javascript/gitlab-lgpl/` | LGPL-3.0-or-later | `LICENSES/LGPL-3.0.txt`, `LICENSES/GPL-3.0.txt` | named upstream contributors |

`LICENSES/GPL-3.0.txt` is present because LGPL-3.0 is written as a set of additional permissions
on top of GPL-3.0 and incorporates it by reference. It is not a license any file here is offered
under on its own.

All upstream header comments are preserved. Some fixtures have no per-file license header; the
subtree map and full license texts above state their terms. Original source URLs are retained where
upstream recorded them.

## Sources

**GitLab SAST rules** — <https://gitlab.com/gitlab-org/security-products/sast-rules>, commit
`d580dedc604363a7606bc0a7192f4edf3e675cae`. The direct source of every file here. Exact paths and
selection criteria are in `PROVENANCE.md`.

GitLab in turn derives parts of this material from:

**njsscan** — <https://github.com/ajinabraham/njsscan>, LGPL-3.0. The origin of the rules and
fixtures under `javascript/gitlab-lgpl/`; the per-file `source (original)` headers name the exact
upstream file.

**eslint-plugin-security** — <https://github.com/nodesecurity/eslint-plugin-security>, MIT,
copyright JS Foundation and other contributors (<https://js.foundation>). The origin of the
fixtures `javascript/gitlab-mit/eval/rule-eval-with-expression.js` and
`javascript/gitlab-mit/xss/rule-mustache-escape.js`, and of the detection patterns several
`javascript/gitlab-mit/` rules cite in their `source-rule-url` metadata.

## Modifications

None. Every file is byte-for-byte as published at the pinned commit. Enactment selects, pins and
packages; it does not edit rule text. What Enactment adds is this directory's `PROVENANCE.md`,
`THIRD_PARTY_NOTICES.md` and `LICENSES/`, which are Enactment documentation of third-party
material rather than modifications of it.
