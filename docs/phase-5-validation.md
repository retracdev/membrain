# Phase 5 validation

Phase 5 delivers the portable official skill and explicit export strategy. The
owner performs any later installation. No managed installer, hook, instruction
editor, provider integration, MCP dependency, or background job was added.

## Observed checks before PR review

Validated locally on Windows on 2026-10-26 with Node 24.19.0, npm 11.17.0, and
Git 2.55.0.windows.5:

- `npm ci` succeeded with zero reported vulnerabilities.
- Formatting, lint, strict type checking, build, and README ownership checks
  passed. `npm run check` completed: 84 tests, 82 passed, no failures, two POSIX
  permission tests skipped on Windows. The 14 new skill tests had 13 passes and
  one permission skip.
- `npm run pack:check` passed the 40-file allowlist, including the exact
  official skill asset. Nothing was published.
- The skill-creator frontmatter validator passed, using its Python dependency
  only in an isolated temporary directory. No user/global Python package was
  installed. Standard-format, relocated-package and offline CLI examples also
  passed the automated tests.
- `npm run demo:skill` passed the isolated export demonstration below and
  removed its temporary destination.
- Root README and LICENSE SHA-256 hashes match the Phase 4 baseline. At this
  initial validation, repository HEAD was
  `c455a146a743923f2e64562291c2453a2a8de25c`.

## PR review follow-up

The review corrected export output that claimed nothing could be activated:
Membrain runs no installer, but an agent can discover a file exported directly
to its skill directory. Human output and the integration reference now describe
that boundary. The deferred `doctor` placeholder no longer claims Phase 5
delivery. The skill now recommends stdin or an explicit `--` delimiter for
arbitrary content, preventing leading dashes from being parsed as CLI options.

The full-suite run exposed a concurrent-export race: a second existence check
could observe an identical file published after the initial absence observation
and incorrectly return `SKILL_EXISTS`. Export now derives content and presence
from the same snapshot, then relies on no-clobber publication to reconcile a
concurrent creator. A deterministic regression reproduces the old failure at
that exact boundary. Oversized existing files still require explicit overwrite.

Scoped `.gitattributes` rules preserve LF for application/tooling files on fresh
Windows checkouts. An isolated checkout with `core.autocrlf=true` verified LF
source, docs and CI files. README, LICENSE and personal memory paths have no new
attributes; their contents are untouched.

Added isolated regression coverage for human export into a mocked agent skill
directory, preservation of a hard-linked neighboring file, missing packaged
assets before directory creation or replacement, and literal option-like memory
content. No real agent environment was configured.

## Implementation

- `skills/membrain/SKILL.md` is an instruction-only Agent Skills manifest with
  provider-neutral CLI examples. It teaches targeted recall, correct scopes and
  explicit sessions, deliberate saves, deduplication, revision-safe updates,
  superseding, tombstones, secret avoidance, and untrusted reference handling.
- `skill export --output DIRECTORY` creates only the selected directory chain
  and `SKILL.md`. It does not load memory configuration, discover agents, run
  Git, run an installer, or configure an agent. An agent may discover files if
  its skill directory is explicitly chosen as output. Different existing content
  needs explicit `--overwrite`; identical exports leave timestamps unchanged.
- Publication is complete-file/no-clobber for new files, atomic replacement for
  explicitly authorized overwrites. Unsafe destination links are refused.
- Package metadata and the exact allowlist include the skill asset. No runtime
  dependency was added. Existing dependency choices and lockfile are preserved.
- Setup/status wording distinguishes portable export availability from managed
  installation, which is unavailable. Configuration schema and memory/sync
  behavior are unchanged. Manual installation/removal is documented in
  [agent-integrations.md](agent-integrations.md).
- `AGENTS.md` records the permanent non-invasive integration boundary.
  Formatting and linting now exclude the existing local `.membrain` data
  directory; its contents were not used or changed for development.

## Reproduction

Use the repository checkout and isolated fixtures, never real agent targets:

```sh
npm ci
npm run check
npm run pack:check
npm run demo:skill
```

Use `npm.cmd` on restricted Windows PowerShell. The demo creates an isolated
temporary review destination, exports successfully, verifies identical export,
verifies refusal to replace a customization, then explicitly replaces that
fixture with `--overwrite`. It removes only its validated temporary directory.
The example command executed inside it is:

```sh
node /absolute/path/to/Membrain/dist/cli.js skill export --output <temporary-directory>/review/membrain --json
```

Expected JSON statuses are `created`, `unchanged`, then `replaced` for the
explicitly authorized replacement. Refusal uses `SKILL_EXISTS`. The final
directory contains only `SKILL.md`; no agent settings, hooks, project
instructions, memory configuration, or integration receipts appear.

## Boundaries and remaining release gates

Implementation changes stay inside Membrain. Tests and demonstrations use
isolated temporary destinations and mocked agent directories. Fleet was not
accessed; external projects and real agent settings were not modified; no skills
or hooks were installed. Root README and MIT license remain owner-controlled and
unchanged. The initial implementation performed no development-repository
commit, push, PR, or npm publication. The later Stage request separately
authorizes committing the reviewed application and opening a PR, but never
publishing a package or merging. Existing Git regression tests create commits/
pushes only in isolated local test repositories.

Native-agent discovery/execution was deliberately not tested on real agent
environments. Manual instructions reflect current official Claude Code/Codex
documentation, not a behavioral compatibility guarantee. macOS/Linux execution
and Windows ACL-specific denial tests remain unobserved locally; the CI matrix
continues to target all three operating systems. The exporter requires hard-link
support for no-clobber publication and a user-controlled directory; see export
race/crash limitations in the integration reference.

The existing ~19-second single warm query over 10,000 memories remains
release-blocking, with a proposed p95 warm CLI recall target <=1 second. No
index/search redesign or benchmark rerun was warranted by this phase. `doctor`
remains deferred. Phase 6 can proceed with release preparation, isolated
packaged installation checks, and separately scoped performance work;
publication still requires owner authorization.
