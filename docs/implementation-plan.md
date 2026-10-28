# Phased implementation plan

## Phase 8: incremental indexing and explicit fast recall

Implementation and evidence: [index-freshness.md](index-freshness.md) and
[phase-8-performance.md](phase-8-performance.md). Strict remains the
compatibility default; explicit fast mode scans real paths and validates
additions/results, reusing validated history. SQLite changes are transactional
on private copies; source/config schemas and Git safety remain unchanged.

Acceptance requires comparable 30-sample 10,000-memory measurements, explicit
mode-specific latency claims, missing-tombstone/edit/concurrency/crash/Git
regressions, package/install checks and observed Windows/macOS/Linux CI. Fast
mode's unreturned-byte limitation must remain explicit. A fast-mode result does
not close the default strict-mode performance blocker. Publication still needs
owner authorization and resolution of the documented release gates.

The first task establishes Phase 1 and specifies later behavior. A phase is done
only when its acceptance checks pass; later phases must not be inferred from
placeholder command names. Root `README.md` remains exclusively owner-maintained
in every phase, including release preparation. Preserve the MIT license.

## Phase 1: foundation (completed)

Deliver a strict TypeScript/ESM package, Commander entry point, version/help,
read-only configuration parsing and status, structured errors, lint/format/type
checks, built-in tests, package allowlist validation, and GitHub Actions.
Document architecture, CLI contracts, setup, contributions, and integration
risks.

Acceptance:

- `npm ci`, `npm run check`, and `npm run pack:check` succeed locally. CI is
  configured for Node 24 on Linux, macOS, and Windows; distinguish configured
  coverage from results actually observed locally.
- Help/version need no configuration. Status handles absent default config and
  explicit custom config, returns valid JSON, and creates no files or Git
  changes.
- Invalid JSON/schema/paths and unknown CLI options fail nonzero with useful
  messages. Malformed config contents are not echoed in errors.
- Each scope defaults to local, independently supports manual/automatic policy,
  and rejects automatic policy without explicit authorization. Reading a policy
  does not activate a sync engine in this phase.
- A capability test proves FTS5 and BM25 on the installed runtime without
  creating a persistent database. SQLite driver selection is explicitly gated
  for Phase 2.
- Root README and license are byte-for-byte unchanged; format tooling excludes
  README and CI checks the ownership restriction. No push, PR, or publication.

## Phase 2: memory engine and retrieval

Implementation status: the local engine and six CLI commands are implemented.
Driver: better-sqlite3 13.x. Layout: immutable per-revision JSONL. Locking:
canonical per-store directory locks without automatic stale-lock theft. See
[memory-engine.md](memory-engine.md) for actual contracts and
[phase-2-validation.md](phase-2-validation.md) for tests, measurements, and
unobserved platform checks. No Git synchronization or agent integration exists.

Before implementation, finalize two decisions with evidence: `node:sqlite`
versus `better-sqlite3` (API stability, install coverage), and immutable
revision JSONL layout (file-count/replay benchmark). Agree the public record
schema and a small filesystem locking/publication strategy. A proof of
durability is more valuable than an early optimization. Configuration remains
local by default.

Deliver schema validation, store identity, portable records, serialized local
writes, revisions/tombstones, session partitioning/promotion, rebuildable
indexes, CRUD, lexical search/recall, and initial secret checks. Explicit
project/root selection can precede the Phase 3 discovery wizard.

Acceptance:

- CLI remember/list/search/recall/update/forget work offline with no Git
  installed; all return documented JSON. No network activity or model dependency
  exists.
- Delete every local SQLite/cache file and reproduce the same active records and
  ranking from JSONL. Index failures after durable writes report saved IDs.
- Race at least 20 child writers, including competing updates of the same
  memory; no missing/malformed published records. Stale expected revisions fail
  clearly.
- Kill writers at publication boundaries; replay preserves all complete records
  and reports incomplete temporary files. Corrupt or incompatible records are
  preserved and prevent a falsely successful rebuild.
- Duplicate revisions/operations are idempotent; conflicting heads and
  delete-versus-update races never use timestamp last-write-wins.
- Sessions never appear without explicit session selection and never promote
  automatically. Promotion retry does not create duplicate durable memories.
- Scope/project/session/tag/status filters, empty/punctuation queries, Unicode,
  literal escaping, BM25 ties, result limits, and recall budgets have fixtures.
- Synthetic secrets are blocked before persistence; retrieval is labeled
  untrusted and cannot execute commands.
- Record replay/search/startup measurements for 10,000 active memories with
  history and bounded recall. Establish measured regression budgets before v1.
- Run crash, filesystem, and SQL tests across Windows, Linux, and macOS.

## Phase 3: initialization and discovery

Implementation status: interactive Inquirer wizard and non-interactive flags,
safe version-1 config persistence/backups, root/identity/path validation,
optional markers, and non-executing agent detection are implemented. No Git
engine, repository initialization, integration installer or automatic job is
included. See [initialization.md](initialization.md) and
[phase-3-validation.md](phase-3-validation.md) for contracts and observed
checks. The existing large-store query latency remains a release blocker, with
proposed measurable gates in [release-blockers.md](release-blockers.md).

Deliver interactive and non-interactive init, modular Inquirer prompts, custom
locations, stable project markers/local mappings, nested-cwd resolution, config
validation/writes, and a setup preview/summary. Detection never offers managed
integration installation; Phase 5 provides a separate explicit portable export.

Acceptance:

- Each scope independently offers local (default), manual, and automatic mode.
  Selecting Git mode is not authorization for `git init`. Automatic requires a
  separate opt-in. `--yes` never grants sensitive permissions by itself.
- Local memory inside a Git repository performs no Membrain Git operations.
  Existing repositories and user-managed commits work without enabling sync.
- Rerunning init preserves memories, IDs, config, and existing user files unless
  the specific modification is authorized. Interrupted setup is recoverable.
- Explicit flags cover all wizard choices; non-TTY input never hangs on a
  prompt. Declined overwrite/Git/automatic consent leaves existing state intact.
- Storage paths with spaces, non-ASCII characters, Windows drives and UNC paths,
  symlink aliases, permission failures, and overlapping roots are tested.
- Nested cwd, non-Git projects, submodules, moved clones, and worktrees resolve
  deterministically without leaking another project's memory.
- Missing Git does not prevent a completely local setup, including session use.

Phase 3 boundaries: agent integrations are reported as unavailable, not offered
for installation. Filesystem `.git` markers suffice for detection; remote
validation and repository creation belong to Phase 4. Platform-neutral fixtures
run in the existing three-OS CI matrix; observed local results are Windows only.
UNC shares and Windows ACL failure injection require additional platform checks
before release. An interrupted multi-directory setup may leave reviewed empty
directories/a marker; it must report recovery guidance, never roll back
memories.

## Phase 4: optional Git synchronization

Implementation status: policy-gated `sync`, exact-path source commits, private
index additive merge candidates, outgoing/incoming history and secret checks,
failure refs/progress snapshots, and authorized foreground CLI mutation triggers
are implemented. See [git-synchronization.md](git-synchronization.md) and
[phase-4-validation.md](phase-4-validation.md). Repository initialization
remains an explicit owner Git action; no `git init` wizard flag was added. This
narrows the original optional initialization proposal while preserving
local-first and existing-repository workflows. No agent integration/daemon is
included.

Deliver policy enforcement, exact managed-file selection, containing-repository
grouping, commit-only/manual remote sync, conservative conflict handling,
offline retries, and explicitly authorized foreground automatic attempts. GitHub
needs no separate implementation. Any future repository-initialization action
needs separate explicit authorization; do not auto-create remotes or hosted
repositories. Keep current init free of Git side effects.

Acceptance:

- Local mode never invokes Git for the store, including explicit `sync`; it
  returns guidance rather than changing policy. Manual mode only runs Git from
  explicit sync. Automatic mode requires the local authorization receipt/policy.
- Test global/project/session as independent combinations, including sharing one
  containing repository. One automatic scope cannot stage another local/manual
  scope's changes. Session sync is never enabled through project inheritance.
- A fixture with unrelated clean files succeeds. Fixtures with unrelated dirty,
  staged, or outgoing committed files refuse without changing those files/index
  or pushing their history. No stash, broad add, force-add, reset, or
  force-push.
- Two offline clones create/modify/delete memories, then sync: stable IDs
  persist, duplicates do not arise, and competing revisions are preserved as
  conflicts.
- Invalid refs, detached HEAD, auth failure, timeouts, rejected pushes, text
  conflicts, and semantic conflicts are actionable and do not destroy saves.
- Secret scanning covers outgoing managed history, not only the latest snapshot.
  Private repositories rely on user Git credentials, never stored credentials.
- JSON reports per-scope/repository results and pending stages. Failed automatic
  sync cannot turn a completed local write into a misleading failed save.

## Phase 5: portable skill and explicit export (implemented)

Deliver one provider-neutral, instruction-only `skills/membrain/SKILL.md`,
bundled in npm, with explicit `skill export --output DIRECTORY`. The owner's
non-invasive strategy replaces earlier adapter/installer/hook plans. Install
receipts, integration installers, instruction-file modification, automatic
activation, and hooks are outside this strategy. `doctor` is deferred to a
separately scoped diagnostic task. See
[agent-integrations.md](agent-integrations.md).

Acceptance:

- The skill documents targeted recall, scope/session selection, durable versus
  temporary saves, deduplication, revisions, secret avoidance, and untrusted
  data.
- Export has no implicit destination, creates only the selected directory chain
  and `SKILL.md`, preserves unrelated files, and changes an existing skill only
  with explicit `--overwrite`. Identical exports are unchanged. Unsafe links and
  path/permission failures produce actionable errors.
- Export performs no agent detection, configuration loading, or Git/provider/
  network operations. Manual CLI use remains independent.
- Isolated tests verify custom paths, JSON/help/errors, offline/no-config use,
  idempotence, concurrent publication, explicit replacement, neighboring files,
  mocked agent settings, and relocated package lookup. Packaging requires the
  exact skill asset; no development/private files leak.
- Manual installation/removal covers documented Claude/Codex skill conventions.
  T3/Cursor discovery is not assumed. Real agent smoke tests require separately
  authorized environments before claiming behavioral compatibility.
- Development stays in Membrain or isolated fixtures. Do not access Fleet,
  modify external projects or real agent settings, auto-install skills/hooks, or
  alter external `AGENTS.md`/`CLAUDE.md`. README and MIT license remain
  unchanged.
- No engine redesign; the p95 warm recall <=1s target and current ~19s single
  warm recall remain a release blocker.

## Phase 6: release preparation

Implementation and measured limitations are recorded in
[release-readiness.md](release-readiness.md), [performance.md](performance.md),
[search-relevance.md](search-relevance.md), and
[installation.md](installation.md). The package remains private and keeps its
development version. This work does not authorize publication; unresolved
performance/name gates remain explicit.

Deliver end-to-end fixtures, installation checks, finalized docs under `docs/`,
versioning/migration policy, and an npm package ready for owner review. Confirm
the intended registry name is available before a release; do not rename the
project or publish to a guessed namespace. Remove the development-only private
package guard only when a release is explicitly authorized.

Acceptance:

- Install the packed tarball globally in isolated prefixes on all three OSes;
  verify executable/shim, help, offline local use, CRUD/rebuild, and optional
  sync.
- No dev dependencies, SQLite databases, temporary files, credentials, fixtures,
  or user configuration leak into the package. Preserve owner README bytes if
  npm includes it automatically; never generate release README content.
- CI is green, dependency/license review is complete, and platform limitations
  (including filesystems and SQLite API status) are documented.
- An offline end-to-end run needs no account, Git, provider, or integration.
- Owner reviews recommended README links separately. Publishing, pushing, and PR
  creation still require explicit instructions; phase completion is not
  authorization for those actions.

## Phase 7: memory engine performance

Investigate full recall latency and optimize measured source replay costs while
preserving the version-1 JSONL authority, disposable SQLite index, lexical
ranking, synchronization boundaries, and offline operation. A complete Phase 7
requires the 10,000-memory warm CLI p95 <=1 second gate; an optimization or a
passing correctness suite alone does not complete that gate.

Implemented work adds opt-in local profiling, reproducible global/mixed-scope
benchmarks and temporary, bounded source replay workers. Full content hashing
and ancestry validation remain mandatory; no metadata-only freshness policy or
source migration is introduced. See [index-freshness.md](index-freshness.md) and
[phase-7-performance.md](phase-7-performance.md) for measurements and
limitations.

Acceptance:

- Measure cold/warm retrieval, startup, replay, index checks/rebuild, FTS/BM25,
  serialization, filesystem work, and memory using disposable datasets.
- Report sample counts and p50/p95/p99, including 100, 1,000 and 10,000
  memories; attempt 50,000 when practical. Distinguish diagnostics from
  uninstrumented end-to-end CLI timings and do not claim causal gains from
  desktop variation.
- Preserve external-change detection, timestamp-restored edit refusal, source
  removal/tombstones, cross-process consistency, scope isolation, corruption
  recovery, Git safety, and deterministic rebuilds. Bound temporary workers
  across concurrent stores and retain complete replay when workers are denied.
- Run the full check, package/install checks and existing lexical regressions;
  observe the Windows/macOS/Linux CI matrix. Keep strict timing assertions in
  dedicated benchmarks, outside ordinary functional tests.
- If latency misses the gate, retain the release blocker and document the
  remaining measured bottleneck and next justified design work. No publishing,
  release, source migration, daemon, model/service or integration installation.
