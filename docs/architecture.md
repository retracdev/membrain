# Membrain architecture specification

Status: Phase 6 retrieval, reliability and release preparation, portable skill
export, optional Git synchronization, initialization and local memory
implemented. Reviewed 2026-10-26. See
[implementation-plan.md](implementation-plan.md) for delivery gates,
[memory-engine.md](memory-engine.md) for implemented behavior, and
[initialization.md](initialization.md) for setup/preservation contracts,
[git-synchronization.md](git-synchronization.md) for sync safety and
limitations, [research.md](research.md) for validation and primary sources.

## Purpose and boundaries

Membrain is a local memory engine invoked by people and terminal-capable agents.
It stores durable knowledge independently of the agent that produced it. It is
not an AI agent, chatbot, hosted service, or orchestration platform. The initial
release needs no account, API key, model, embeddings, network connection, MCP
server, or MCP dependency. No telemetry is collected. GitHub is an optional Git
host; no GitHub API or GitHub-specific identity is required.

The owner exclusively maintains the root README. All additional documentation
belongs in `docs/`; automation must exclude root `README.md`.

## Technology and code boundaries

Use strict TypeScript, ESM, npm, and Node.js >=24.15.0, recommending the latest
patched Node 24 LTS. Compile with `tsc`; distribute JavaScript with a CLI
shebang. Commander handles arguments and help. Modular `@inquirer/prompts` 8.x
provides the Phase 3 wizard (MIT; Node baseline compatible). Use native Node
filesystem, crypto, child processes, and `node:test`; avoid a bundler,
application framework, and service process.

SQLite with FTS5/BM25 is the v1 search technology. There are two driver options:

- `node:sqlite`: no native npm dependency or install build step, already
  available in the development runtime; its API is a release candidate in the
  inspected Node 24 documentation.
- `better-sqlite3`: established external synchronous driver, but native prebuild
  coverage and compiler fallback complicate installation and supported
  platforms.

Phase 2 decision: use `better-sqlite3` 13.x behind the internal index module.
Its established API takes precedence over minimizing dependency count while
Node's API remains a release candidate. The installed package includes native
binaries for Windows/macOS/Linux; native loading, FTS5, BM25, and persistent
rebuild tests pass locally on Windows. CI runs the same tests on all three OSes;
results on the other two are not yet observed. See the driver decision in
`research.md`.

The source layout grows only as needed:

- `src/cli.ts`: parsing, output, exit codes; no persistence policy.
- `src/config.ts`: versioned validation and paths; currently read-only.
- `src/errors.ts`: stable application error codes.
- `engine/`: records, revisions, concurrency, lifecycle, scope selection.
- `storage/`: portable filesystem storage and local locks.
- `index/`: SQLite projections and search.
- `sync/`: explicit Git policy, source/history validation and repository
  operations.
- `src/skill.ts` and `src/cli-skill.ts`: bounded static asset export and CLI
  parsing/output, with no agent configuration lookup or installer.
- `skills/membrain/SKILL.md`: the packaged provider-neutral instructions.

Use ordinary functions and narrow interfaces, not a plugin system, event bus,
dependency injection framework, or public library API in v1. Nothing in the
engine imports Commander or an agent SDK.

## Scope identity and isolation

Global memory has an explicitly configurable storage root. It may be in a Fleet
repository, a different directory, or the user configuration area. The home
directory is a suggested default only; it never defines the scope identity.

Project memory uses a stable UUID generated at initialization. Names, repository
URLs, and absolute paths are not project identifiers: repositories can be moved,
renamed, cloned, or have multiple worktrees. A small portable project marker
`.membrain/project.json` may contain the ID and format version. It must not
contain another user's absolute external storage path or authorization settings.
The local configuration maps checkout roots to project IDs and storage roots.
External-only setups can omit a project marker and use the local mapping; a new
clone then requires explicit reassociation with its existing project ID.

Project resolution, implemented in Phase 2 without writing
configuration/markers:

1. Honor explicit project selection; ambiguity or unknown ID is an error.
2. Canonicalize the current directory (including symlinks) and select the
   deepest registered ancestor by path components, never string prefix (`app` !=
   `apple`). Do not select an ancestor above an intervening nested repository
   boundary; a registered parent must not capture an unregistered submodule.
3. For unregistered locations, walk ancestors for project markers and Git root
   markers (`.git` directory or worktree/submodule `.git` file). Filesystem
   discovery works in local mode without invoking Git. Stop at the nearest
   repository boundary, so submodules do not silently inherit a parent project.
4. Resolve a portable ID to a configured store. Do not create a project or pick
   another project's memory merely because the cwd is a repository.
5. Outside a configured project, read global only (and an explicitly selected
   session); project writes require selection/configuration. Explicitly
   registered non-Git projects work too.

Worktrees sharing an ID share project memory if their local mappings point to
the same store. Distinct worktrees may opt into different project IDs. Define
case, drive-letter, UNC, symlink, missing-root, and moved-checkout behavior with
Windows/POSIX fixtures. The Phase 3 wizard creates/validates these mappings
interactively; Phase 2 consumes existing mappings and markers.

Session memory always requires an explicit opaque session identifier supplied by
the user/agent. Generating an ID for the caller is deferred. Never infer the
session from terminal PID, cwd, or the last active process. It is isolated under
the configured session base by project ID (or a global namespace) and safe
encoded session ID. Distinct agents may deliberately share a session ID. No
fallback to all sessions is permitted in normal recall.

Session files persist locally until explicit discard or user-configured expiry;
they remain temporary in meaning. Ending an agent process does not promote them.
Initially `remember --scope session --session ID` persists session context;
`remember --promote ID --to project|global` explicitly copies it to a durable
scope with a new memory ID and origin reference.
`forget --scope session --session ID --all --yes` discards it logically.
Promotion is retry-safe via an operation ID; multi-store promotion is not one
atomic filesystem transaction. Retain the source session until the destination
write is verified. Physical cleanup/purging is deferred and requires separate
confirmation.

## Configuration and synchronization policy

Configuration is local user data, never executable code. Resolution precedence
is `--config`, then `MEMBRAIN_CONFIG`, then `%APPDATA%/membrain/config.json` on
Windows (fallback `~/AppData/Roaming`), or
`$XDG_CONFIG_HOME/membrain/config.json` on POSIX (fallback `~/.config`). Paths
inside the file resolve relative to that file; leading `~` expands to the
current user's home. No shell or environment-variable interpolation occurs. An
explicit missing file is an error; an absent default file means unconfigured and
creates nothing.

Schema version 1 supports omitted/disabled scopes, global storage, a project
registry, and a session base. Each storage entry has an independent sync policy.
Omitting `sync` normalizes to `{ "mode": "local" }`.

```json
{
  "version": 1,
  "global": {
    "path": "../Fleet/membrain",
    "sync": { "mode": "local" }
  },
  "projects": [
    {
      "projectId": "b8a6d4cc-f7b0-4cd4-8caa-bc414d2ff5ce",
      "root": "../code/example",
      "path": "../code/example/.membrain/project",
      "sync": { "mode": "manual", "remote": "origin", "branch": "main" }
    }
  ],
  "session": {
    "path": "../local-sessions",
    "sync": { "mode": "local" }
  }
}
```

The three modes apply equally to global, project, and session storage:

- **Local (`local`, default):** Membrain makes no Git calls for this storage,
  never initializes a repository, and never commits, fetches, merges, or pushes.
  Files may live inside an existing repository and users may commit them with
  their own tools. Merely finding `.git` does not enable Membrain Git
  management. Explicit `sync` refuses a local scope and explains how to
  configure manual mode.
- **Manual (`manual`):** memory operations stay local. Only an explicit
  `membrain sync` may perform authorized Git work for selected manual scopes.
  Wizard permission to configure sync is distinct from permission to create a
  repository. No implicit post-write or startup synchronization occurs.
- **Automatic (`automatic`):** requires `authorized: true` in locally trusted
  user configuration, written only after the user opts in and reviews paths,
  managed files, history/privacy implications, branch, and remote. A future
  foreground CLI mutation attempts sync after a durable save. No daemon, timer,
  or background service is needed. The local save succeeds even if sync is
  offline; report pending sync separately. Automatic attempts never repair
  conflicts, change branches, initialize repos, or broaden the authorized file
  set.

For example, a separately authorized scope can use:

```json
{
  "mode": "automatic",
  "authorized": true,
  "remote": "origin",
  "branch": "memories"
}
```

Remote values are Git remote **names**, never credential-bearing URLs. No remote
means commit-only; a remote requires an explicit branch during init validation.
Validate actual branch refs with Git before executing any Git-enabled operation.
No configuration in a fetched memory store or project marker can grant local
automatic authorization. Changed scope locations/targets require renewed consent
when modified through init. A manually edited local configuration is user input;
document that setting `authorized: true` grants the same capability.

Independent policies do not make Git transactions independent when scopes share
a repository. Group by canonical repository root, lock once, and include only
the scopes eligible for that trigger. An automatic project write must not stage
pending global/manual or session/local files. Identical/overlapping scope
storage roots are rejected at init, including symlink aliases; sharing the
containing repository is supported. Imported history may contain unrelated
paths, so push safety requires outgoing history checks, not just staging
filters.

Phase 1 validates shape, versions, mode/authorization, portable IDs, and paths.
Phase 3 implements filesystem permission checks, symlink containment, overlap
and portable remote/branch syntax checks. Repository/remote validation is
performed by the Phase 4 sync engine. Unknown keys fail with field-level errors,
without echoing file contents. Configuration writes use a same-directory
temporary file, durable flush, replacement, and a recoverable backup under a
config lock. Never silently migrate unknown future schema versions.

## Portable records and file layout

JSONL is the only authority. SQLite may always be deleted and rebuilt. A store
layout contains `store.json` (version and store UUID) and immutable
`records/<memory-uuid>/<revision-uuid>.jsonl` files. Each file is valid UTF-8
JSONL with one full revision and a final newline. Sharding by ID prefix can be
added if benchmarks justify it, with a versioned migration.

A revision contains:

- `schemaVersion`, stable memory `id`, unique `revisionId`, and
  `parentRevisionIds`.
- `content`, `scope` (`global|project|session`), and `type` (initially `fact`,
  `decision`, `preference`, `constraint`, `task`, or `note`).
- `projectId` for project memory and project-associated sessions; `sessionId`
  required only for session memory. A global record cannot masquerade as project
  memory. Validate records against their store/partition.
- `createdAt` and `updatedAt` in UTC RFC 3339, preserving creation time on
  updates.
- Optional `sourceAgent` and promotion origin; tags/metadata are always present.
  A future cross-memory `supersedesId` link is not implemented.
- `status`: `active`, `superseded`, or `deleted` (a logical tombstone).
- Optional client `operationId` paired with `operationKind` for retry-safe
  writes.

Use `crypto.randomUUID()`; do not add an ID package or derive IDs from
timestamps or content. Updates retain the memory ID and create a revision
referring to the expected head. Replacing a decision with a different memory can
explicitly mark the old logical memory superseded. Ancestor revisions remain
historical even if their original status was active. Never reuse IDs after
deletion.

Why multiple small JSONL files: a shared append file requires portable
interprocess locking and is a frequent Git conflict hotspot. Immutable
per-revision files avoid shared appends and retain concurrent edits. The cost is
file count and full snapshot history. Benchmark 10,000 active memories with
several revisions before v1; defer compaction, export bundles, and alternative
layouts until measured. This layout is a recommendation with a Phase 2 benchmark
gate.

## Concurrent writes, durability, and recovery

Do not assume append or rename gives a portable transaction by itself. Writers
acquire a per-store lock using atomic directory creation, a random ownership
token, bounded retries, and a heartbeat. The store-level lock also serializes
deduplication and operation-ID checks across memory IDs. Canonical paths prevent
symlink aliases from creating separate locks. No lock is stolen automatically,
including after a process crash; recovery requires inspected manual cleanup.
Support local filesystems first; network shares and cloud-folder live
synchronization have no guaranteed locking semantics.

While locked: validate all input and scan secrets, read the current heads,
enforce `expectedRevision`, create a uniquely named temporary file in the
destination directory with exclusive creation, write the complete
newline-terminated revision, flush/close, and publish without clobbering an
existing revision. Pick and test a no-clobber primitive (for example a
same-filesystem hard link of the completed temporary file); do not silently fall
back to an unsafe overwrite. Flush the directory where supported; document
Windows durability differences. Release the lock only after the published record
is verified. Immutable names make lost-lock races detectable rather than
destructive. Unsupported filesystems fail safely.

The SQLite transaction follows the durable JSONL commit. If projection fails,
return the saved memory ID plus an index warning rather than implying the write
was lost and encouraging duplicates. Cache/index locks serialize local
projection changes and rebuilds; readers use a consistent SQLite transaction.
Rebuild into a new local generation and switch only after validation. Keep index
caches outside portable stores, keyed by canonical store identity; SQLite
WAL/SHM stay local.

Replay validates schema, ID/path agreement, complete JSONL lines, revision
graph, and duplicate revision IDs. Identical IDs with identical data are
idempotent; different data with the same revision ID is corruption. Never use
wall-clock last-write-wins. Multiple head revisions form a semantic conflict:
preserve both, exclude from normal recall, and expose in list/doctor for
explicit resolution. A resolving revision lists all accepted heads as parents.
Deletion concurrent with an update is also a conflict, never silent
resurrection.

Malformed files remain intact. Doctor reports their paths and line numbers,
without echoing potentially secret content. A rebuild must not replace a healthy
index with an incomplete projection and claim success. Temporary/unpublished
files are ignored and reported; repair/quarantine requires explicit
authorization and backup. Do not auto-rewrite or delete source records. Schema
migrations are versioned, opt-in, and tested with older fixtures.

## Index and deterministic retrieval

Before retrieval, validate and hash a scan of the source files. Reuse a current
projection through a read-only SQLite connection without cache writes or locks;
refresh a missing/stale/damaged projection under the index lock. Track a local
manifest of revision paths and content hashes, not just file modification times.
The simple initial strategy enumerates and hashes source files at invocation
with bounded asynchronous I/O; the measured synchronous-read experiment was
slower and was discarded. New revisions trigger a complete transactional
index-generation rebuild; changed immutable files are validated and reported as
corruption rather than silently trusted. Detected invalid sources prevent normal
recall from presenting a stale index as current. Concurrent files published
after the scan appear on the next invocation; no cross-store global transaction
is promised.

Build a relational projection of current non-conflicting revisions plus FTS5
over content and tags. Use bound SQL parameters; memory text is never SQL or a
shell command. Use FTS5 `unicode61` tokenization (default diacritic removal)
without stemming in v1. Plain queries become escaped literal tokens combined
with OR; never pass untrusted text straight into FTS query grammar. Ignore
punctuation, deduplicate tokens, reject empty/tokenless queries, and impose
documented query and result-size bounds. Raw FTS grammar can be a later explicit
option.

English function words are dropped from mixed queries; `--literal` keeps every
token for SQL and other technical queries. All-function-word queries retain
their tokens. No domain-specific synonyms or inferred concepts are added.

Ranking: `bm25(fts, 1.0, 2.0)` for content and tags, ascending (smaller scores
are better), then stable memory ID ascending. Do not silently add recency,
agent, or scope boosts. Use one transient/local combined projection for
applicable stores so scores share a corpus; separately computed scope BM25
scores are not directly comparable. Corpus selection is part of the query:
materialize only enabled global, selected project, and selected session
partitions before ranking. A SQLite schema/tokenizer upgrade may change scores;
ranking is deterministic for the same corpus, query, and SQLite version, not
promised identical across engines.

`--read-only` requires an already current, readable index for exactly the
selected scope set and fails rather than performing maintenance. Source
validation still runs; recall never mutates JSONL. See
[performance.md](performance.md) and
[release-readiness.md](release-readiness.md) for measurements, limitations, and
remaining publication gates.

`recall` searches enabled global plus current project and only the explicit
session; no automatic all-project/all-session expansion. `search` has the same
safe default but permits explicit broader filters. `list` can list metadata and
history without an FTS query. Default search limit: 10, maximum: 100; recall: 5
results with a default total 4,000-character budget, explicit truncation flags,
and citations containing memory/revision IDs, scope, type, tags, and timestamps.
JSON returns the same selection and truncation information. Empty matches are a
successful empty result. No embeddings, LLM calls, or whole-store context dumps.
Future semantic search must be optional, local, and preserve lexical fallback.

## Initialization (implemented)

The Phase 3 wizard reads existing configuration, asks which scopes to enable,
offers custom roots for each, and defaults each scope independently to local. It
can recognize Git marker files without invoking Git in local mode. Git-backed
modes store policies without inspecting remote state during init. Repository
creation remains an explicit owner action; there is no `--init-git` flag. Never
run `git init` merely because a path exists or sync was selected.

Show a preview of new directories/files and scope policies and destinations
before applying. Initialization never changes agent files. Changing or replacing
existing user files requires permission for those exact changes. Rerunning
preserves IDs, paths, policies, memories, and integrations unless the user
chooses a change. Validate before writing and report partial setup with safe
recovery instructions if cross-directory setup fails.

Non-interactive init uses explicit paths/modes, no prompt in a non-TTY. `--yes`
accepts non-destructive defaults only: it is not consent to enable automatic
sync, initialize Git, overwrite user files, install hooks, or delete anything.
Separate implemented flags authorize config replacement and automatic policy
(see [initialization.md](initialization.md)); integration installation and
repository creation are not available. Agent detection is a hint from
executable/config presence; it is never permission to install, run an agent, or
contact a provider. Unsupported or missing agents do not block setup.

Configuration remains version 1. Init preserves original bytes when unchanged;
changed files require permission and an exact private backup before atomic
replacement. Config-parent locking, no-clobber marker publication, and snapshot
rechecks reject concurrent stale previews. Config is saved last; cross-directory
failures report partial setup without deleting memory/user files. See the setup
reference for recovery and non-cooperating-editor race limitations.

The existing 10,000-memory warm-query latency is an open release blocker; see
[release-blockers.md](release-blockers.md) for measurement boundaries and
targets.

## Git synchronization safety (implemented)

Native Git is optional and shell-free. Local operations work without a Git
executable. No implicit authentication prompts in agents or hooks: bound
timeouts, non-interactive Git transport, and actionable offline/auth errors.
SSH/HTTPS credentials belong to Git/OS facilities, never Membrain configuration.

For an explicitly eligible scope:

1. Resolve canonical containing repository/worktree and scoped managed paths.
   Reject symlinks escaping ownership boundaries, unresolved merges, detached
   HEAD, unsupported branches, and invalid scope/remote configuration.
2. Lock this repository for Membrain operations and recheck status/HEAD after
   each step. Refuse unrelated staged or dirty files in v1; never stash/reset
   them. This conservative rule still supports repositories with unrelated clean
   files. A future isolated-worktree implementation can relax it separately.
3. Validate managed records and secret-scan the exact candidate content/history.
   Allowlist only `store.json`, revision files, and explicitly owned markers.
   Never `git add .`, `commit -a`, or include SQLite/config/session files from
   other policies. Respect existing ignores; do not force-add ignored files.
4. Stage explicit literal/NUL-delimited paths and commit with `--only` for those
   exact paths, excluding unrelated concurrent staging. Refuse unexpected index
   state and never rewrite prior commits. New ignored sources are errors, not
   silently omitted changes.
5. If a remote is configured, fetch the specified remote/branch only. Check all
   outgoing commits and their complete changed paths: a push must not transmit
   unrelated local commits merely because the newest commit is Membrain-owned.
   Refuse such outgoing history and suggest a dedicated memory branch/repository
   or owner-managed Git. Do not change targets on the user's behalf.
6. Validate the prospective revision union before import. Divergence with only
   additive owned paths uses a private index and `commit-tree` to build an
   audited two-parent merge candidate, followed by `merge --ff-only`. No text
   merge driver, automatic rebase, force-push or remote overwrite is used.
   Conflicting path bytes, identities or semantic heads preserve both histories
   via local source and fetched recovery refs; do not import/push the conflict.
7. Push only the explicitly configured ref without force. Rejected concurrent
   remote updates remain pending; bounded retry only after revalidation.

Git has no atomic transaction spanning local records, index, remote, and local
search projection. Persist/report each durable stage so retry is idempotent. An
offline or rejected push does not undo a memory save or duplicate it on retry.
Partial success across repositories is reported per repository and scope, with
nonzero exit for an explicitly requested failed sync. Automatic sync failure
keeps successful saves successful, with pending-sync metadata and diagnostics.

Git hooks are disabled for Membrain-managed operations, and content filters,
encoding conversions and ident expansion on managed paths are rejected. Native
transport/credential helpers remain trusted user Git configuration. No custom
merge driver or global Git settings are required. Private repositories work via
existing Git credentials without interactive prompts. No GitHub account is
needed for local or local-Git use. See
[git-synchronization.md](git-synchronization.md) for exact automatic CLI
triggers, progress stages, timeout and recovery contracts.

## Integrations, privacy, and trust

See [agent-integrations.md](agent-integrations.md). The official portable
`skills/membrain/SKILL.md` teaches targeted CLI retrieval and deliberate saves.
It is packaged as a static asset. `skill export --output DIRECTORY` writes only
`SKILL.md` at the explicit destination; identical files are unchanged, different
files require `--overwrite`, and directory symlinks/junctions are refused.
Export is independent of memory configuration, Git, and agent discovery. It uses
complete-file no-clobber publication and explicit atomic replacement. There is
no implicit agent destination, installer, hook, instruction-file editor,
activation, or repository scan to enable integrations. Installation/removal is
manual and never deletes memories. Development must stay in Membrain or isolated
temporary fixtures and must not access Fleet or alter real agent settings or
external projects. CLI use requires no integration, and skill invocation grants
no new synchronization authorization. Native-agent smoke tests remain owner-run
validation; do not claim identical discovery or hooks across agents.

Reject obvious private keys, credential assignments, and recognizable token
patterns before writes and sync. Report the rule and location without printing
the detected value. Do not offer an automatic bypass to agents. Pattern
detection cannot guarantee secret absence: review content before sharing;
arbitrary text, proprietary details, and obfuscated secrets can evade detection.
Test with synthetic secrets, not live credentials. A deletion tombstone is not
secure erasure: old revisions, Git history, remotes, backups, and copies retain
content. Document credential rotation and coordinated Git history removal
separately; never rewrite history automatically.

Retrieved memories are untrusted reference data. Label and delimit them and
include provenance; instructions inside them cannot grant permissions or
override the current user/repository policy. Saving into a Git directory does
not itself transmit anything, but the owner's independent Git tools may do so.
Private Git is not encryption. Use restrictive local permissions where
supported, acknowledge Windows ACL differences, and avoid content in diagnostic
logs. No telemetry or automatic network requests; explicit/authorized Git is the
only v1 transport.

## Main risks and release gates

- Filesystem concurrency and crash consistency: multi-process/kill tests on all
  three OSes, no-clobber publication, lock recovery, unsupported-filesystem
  errors.
- Git conflicts and shared repositories: preservation fixtures for unrelated
  files/index/history, remote races, textual and semantic conflicts, and
  retries.
- Scope leakage: nested repositories, symlinks, worktrees, explicit sessions,
  external roots, and disabled scopes must have isolation tests.
- Integration reliability: current official skill-format/discovery docs, bounded
  CLI guidance, explicit exports and manual installation; real agent smoke tests
  require a separately chosen environment. No hooks or automatic capture.
- Portability and maintenance: inspect SQLite stability, test packaged installs,
  benchmark many revision files, version formats, and retain replay fixtures.

Non-goals for v1: semantic search, compaction/GC, encrypted sync, hosted
backups, multi-user authorization, automatic conflict resolution, a GUI, and
MCP. Before making a costly format or driver commitment, present measured
options and record the chosen decision. The implementation phases intentionally
gate those choices.
