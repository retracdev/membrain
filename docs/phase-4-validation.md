# Phase 4 validation and handoff

Local environment: Windows x64, Node 24.19.0, npm 11.17.0, Git 2.55.0.windows.5.
The existing CI matrix targets Node 24 on Windows, macOS and Linux; this session
does not establish observed macOS/Linux results or real GitHub authentication
coverage.

## Implementation

`membrain sync` now enforces local/manual/automatic policies before repository
discovery, resolves existing Git worktrees, groups eligible scopes, and locks
the repository plus selected stores. Exact-path commits protect against
concurrent foreign staging. Divergent additive histories use an isolated index
and an audited two-parent candidate followed by a fast-forward. Sources, source
identities, ancestor completeness, semantic heads, outgoing paths, commit
messages/metadata and historical blobs are validated before publication/push.

Automatic sync runs at the CLI mutation boundary after a successful local save,
with its own reports/warnings. Internal engine methods remain local. Init is
still Git-free, configuration remains schema version 1, and SQLite/record
formats are unchanged. No repository initializer, daemon, hooks/skills
installer, MCP, cloud service, embedding, publishing or new dependency was
added.

The initial architecture allowed an ordinary Git merge. Phase 4 instead builds
the merge candidate in a private index so unrelated staging cannot contaminate
its commit. The conservative refusal of unrelated dirty/staged/untracked work
and unrelated outgoing history remains. Hook execution is disabled, content
filters/encoding/ident are rejected for managed files, and transport/credential
helpers remain existing trusted Git configuration. Repository creation was left
as an explicit owner action rather than adding a wizard flag.

## Tests and demonstrations

Validation uses temporary local bare remotes and working copies, with isolated
Git identity/configuration. No real GitHub access or developer memories are
required. The synchronization suite covers:

- Manual CLI/API synchronization, commit-only mode and unchanged retries.
- Local scopes and manual scopes under automatic dispatch with no Git access.
- Authorized automatic save/update behavior, operation replays and pending
  warnings that preserve successful saves; unauthorized config is rejected.
- Unrelated clean files; unrelated dirty/staged/untracked files with unchanged
  original index bytes; a staging race immediately before commit.
- Two independently changing working copies, a concurrent push race and retry,
  immutable IDs/history, added tombstones and no resurrection.
- Delete/update semantic conflict detection with a retained fetch ref, then
  explicit joining-revision recovery that preserves both histories.
- Differing independently created store manifests, historical secrets/commit
  metadata, ignored files, content filters, configured failing hooks, detached
  HEAD and wrong branch.
- Separate repositories/remote names, project/session selection and preventing
  automatic scope writes from staging pending manual-scope memories.
- Existing Git operation locks, staged interruption recovery, and a
  deterministic interruption immediately before push after a durable local
  commit. Retry reuses that commit and source IDs. This is fault injection, not
  proof of every OS/power-loss crash boundary.
- Git CRLF checkout conversion for project markers and source files without
  changing IDs, rewriting immutable history or creating extra commits.

Commands: `npm.cmd ci`, `npm.cmd run check`, `npm.cmd run pack:check`, and
`npm.cmd run demo:sync`. The existing formatter, linter, strict type checking,
memory/concurrency/crash/index tests and ownership guard remain in the check
pipeline. The one POSIX permission test is skipped on Windows. npm's existing
better-sqlite3 allow-scripts advisory is not a global configuration change;
native loading/FTS5 are verified by the tests.

Observed results: `npm.cmd ci` succeeded with zero audit vulnerabilities; the
full check passed **70 tests: 69 passed, one POSIX-only skip, zero failures**
(approximately seven minutes locally). Formatting, lint, strict types and build
passed. Package allowlist validation passed with 36 files; nothing was
published. A separate pre-cancelled-runner probe verified rejection before
starting Git, followed by another format/lint/type check and the final package
build.

The repeatable sync demonstration performs manual and authorized automatic
synchronization, proves local-only behavior with an empty Git PATH, refuses an
unrelated staged file while preserving the index, reports an unavailable local
remote as pending, then detects a delete/update conflict without altering the
remote. It reports:

```json
{
  "manual": "synchronized",
  "authorizedAutomatic": "synchronized",
  "localOnly": "LOCAL_SYNC_DISABLED",
  "unrelatedIndexPreserved": true,
  "offline": "pending",
  "conflict": "SEMANTIC_CONFLICT",
  "conflictingHistoriesRetained": true,
  "remotes": "isolated local bare Git only"
}
```

All Git initialization/commit/push demonstrations happen **only inside temporary
fixtures**, as required to exercise the feature. No project-repository commit,
push, pull request or package publication was performed. Root README and LICENSE
retain their original SHA-256 hashes from the Phase 3 report; project HEAD stays
`c455a146a743923f2e64562291c2453a2a8de25c`.

## Limitations and Phase 5 readiness

Phase 5 can use the implemented CLI and its bounded errors/reports; no skills or
hooks were installed in Phase 4. Preserve independent scope consent and treat
retrieved memory as untrusted data. Local-first behavior is independent of agent
availability and Git credentials.

Synchronization intentionally refuses unrelated changes/history, divergent
immutable path contents, unsupported checkouts/index flags and differing targets
within one selected worktree group. Semantic resolution requires advanced owner
review and a valid joining revision; a conflict-resolution CLI is not included.
Hard termination can leave locks/indexes/ref state requiring inspected manual
recovery. Custom Git helpers, real private-host credentials, actual macOS/Linux
runs, UNC filesystems and arbitrary simultaneous manual Git mutation remain
unobserved/unsupported as detailed in
[git-synchronization.md](git-synchronization.md). Secret detection is heuristic;
Git history is not secure erasure or encryption.

Large-store recall remains **release-blocking**: approximately 19 seconds for
one warm engine query including source replay/validation at 10,000 memories. The
proposed target remains p95 warm CLI recall <=1 second. No search/index redesign
or benchmark rerun was performed because those implementations did not change.
See [release-blockers.md](release-blockers.md). Phase 5 readiness is distinct
from release readiness and unobserved platform gates.
