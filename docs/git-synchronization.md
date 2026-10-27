# Optional Git synchronization

Phase 4 implements native Git synchronization. GitHub is one possible host;
Membrain uses no GitHub API, account system, token store, MCP, or background
service. Local memory commands work offline without Git installed.

## Policies and selection

| Scope policy                    | Memory commands                                    | Explicit `membrain sync`                                |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `local` (default)               | Filesystem/index only; no Git process              | Implicit scope skipped; explicit scope fails before Git |
| `manual`                        | Filesystem/index only                              | May commit and synchronize that scope                   |
| `automatic`, `authorized: true` | Foreground attempt after a successful CLI mutation | May synchronize explicitly too                          |

Policies remain independent for global, project and session memory. Files inside
an existing Git repository can remain local, with the owner managing Git. No
repository is initialized and no branch, remote or credential is created by
Membrain. Repository initialization remains an owner action, rather than an
additional wizard option in this phase. Git 2.43+ is recommended; local checks
used Git 2.55.0.windows.5. Tests use only local repositories/remotes.

```sh
membrain sync
membrain sync --scope global --json
membrain sync --scope project --project my-project --json
membrain sync --scope session --session task-42 --json
membrain sync --all-projects --json
```

The default selects configured global/current project memory. Sessions are never
enumerated implicitly: supply an explicit `--session ID`. `--all-projects`
cannot combine with `--project`; with a session ID it selects that ID's project
partitions explicitly. The engine's existing scope/root resolution applies.

Configure policies with `init`, including `--overwrite-config` for changes:

```sh
membrain init --non-interactive --global-sync manual \
  --global-remote origin --global-branch main --overwrite-config
membrain init --non-interactive --project-sync automatic \
  --project-remote memory --project-branch main \
  --authorize-project-auto-sync --overwrite-config
```

Remote values are existing Git remote **names**, never URLs/credentials. Omit
the remote for **commit-only** synchronization. A remote requires an explicit
branch matching the checked-out branch. Commit-only mode may omit the branch,
meaning the current checked-out branch. Detached HEAD is refused; Membrain never
switches branches. A manually edited local `authorized: true` grants the same
automatic capability as wizard consent. Imported JSONL/markers cannot grant it.
Changing locations/targets through init requires renewed consent. Init itself
still performs no Git operations or synchronization.

Prepare repositories/branches/remotes and Git identity with your normal Git
tools before sync. Existing clean unrelated files are supported. Fetch and push
must resolve to one identical remote URL; mirror remotes/multiple push URLs are
refused. Different scopes may use different repositories and remote names.
Selected scopes sharing a worktree must agree on the target. Use separate
repositories for independent targets; a shared branch carries its complete
history, so separate remote names alone cannot isolate its contents.

## Managed files and conservative repository safety

Only these exact paths are eligible:

- Selected stores' `store.json` manifests.
- Complete `records/<memory UUID>/<revision UUID>.jsonl` files in those stores.
- Existing validated `.membrain/project.json` markers for selected projects,
  when the marker and storage are in the same containing worktree.

SQLite, caches, configuration, backups, locks, temporary files, other scopes and
other sessions are excluded. Existing ignores are respected; newly saved ignored
memory files produce an error, never a force-add. Configure cache/config outside
the repository or manage their ignore rules yourself. Membrain does not edit
`.gitignore`. Explicitly selected session sync also requires ignore rules that
permit those selected source files; session storage is local by default.

Synchronization refuses unrelated dirty, staged or untracked files. This
includes pending changes in an unselected manual/local scope sharing the
repository. Finish/review your own changes yourself, select the intended
eligible scopes together, or use a dedicated memory repository. There is no
auto-stash, reset, clean, rebase, checkout, history rewrite, broad add, or force
push. Original files and unrelated index entries stay in place.
Skip-worktree/assume-unchanged entries, sparse/partial/shallow checkouts, legacy
grafts, existing Git operation locks and unfinished merges/rebases are refused.

Incoming and outgoing **commits**, including merge parents/root commits, must
change only the selected managed files. Changes must be additions: revisions and
manifests are immutable. Physical deletion, replacement or edits require owner
review; logical deletion is an added tombstone. Outgoing commit messages,
author/committer metadata and all changed managed blobs are secret-scanned,
including inactive/deleted history. A clean working tree is insufficient if an
unrelated outgoing commit exists. A new remote branch requires scanning the
entire reachable local history. Push an unrelated bootstrap history yourself or
use an existing shared baseline; Membrain will not transmit it automatically.

## Transaction strategy

Membrain locks Git's canonical common directory at
`<git-common-dir>/membrain-sync/.membrain-lock` and locks selected stores in
canonical path order. Other cooperating Membrain writes serialize behind those
locks. Linked worktrees share the repository lock. Git commands use argument
arrays with `shell: false`, literal/NUL-delimited path lists, timeouts, and
non-interactive authentication. Repository-routing environment variables and
replace refs are disabled for scoped operations.

After validating local sources, attributes, status, identities and branch:

1. Fetch only the configured branch into a unique `refs/membrain/fetch/<UUID>`
   recovery ref, without changing `FETCH_HEAD`, configured tracking refs, tags,
   other branches or submodules. The worktree remains unchanged during
   validation. No common history means refusal.
2. Validate source/identity integrity and the prospective local/remote revision
   union. A same-path content mismatch, corrupt/missing ancestor, secret, or
   semantic conflict stops before import/push. No timestamp winner is chosen.
3. Stage only the validated local additions using a literal NUL-delimited list.
   Commit with `git commit --only` using that exact list, excluding other staged
   paths even if a different Git process stages them after preflight. Git
   manages its own index/ref locking. Managed staged additions from an
   interrupted attempt can be retried if their working copies still agree.
4. If histories diverge, create a merge tree in a **private index** based on the
   local commit, adding only validated remote paths. `commit-tree` creates an
   unsigned two-parent candidate; audit it before advancing the worktree with
   `merge --ff-only`. An ordinary fast-forward also uses this exact-ref path.
   This avoids text merge drivers and real-index staging contamination in merge
   commits. It does not rewrite existing history.
5. Recheck branch/HEAD/status, validate committed sources, and audit outgoing
   history again. Push the audited commit SHA to the one configured branch,
   without force or implicit tag/submodule pushes. Remote races/rejections are
   pending work, never permission to overwrite the remote.

Git hooks are disabled for these commands; managed content filters, encoding
conversions and ident expansion are rejected. Git's configured transport and
credential helpers remain trusted local Git configuration and may execute their
normal programs. Existing SSH agent/keys or stored HTTPS credentials support
private repositories. Membrain disables Git/GCM interactive prompts and uses
OpenSSH batch mode by default; custom SSH/helpers remain the owner's
responsibility. No memory body is interpolated into shell commands.

Ordinary Git LF/CRLF checkout conversion is accepted for JSONL and manifests/
markers. Other byte changes to immutable files are conflicts. Clone/synchronize
the shared store manifest before writing in a second checkout: independently
created stores at the same Git path have different store IDs and must be
reviewed rather than silently combined. Git checkout permissions follow Git/OS
umask; use a private storage directory and appropriate Windows ACLs for
sensitive data.

## Automatic behavior

Only successful CLI `remember`, `update`, `forget`, explicit session promotion,
and session discard trigger automatic attempts, after durable storage/index work
releases its locks. Only the changed destination scope/session is eligible. One
bulk discard attempts once per selected session, not once per tombstone.
Operation-ID replays and unchanged deduplication do not trigger another attempt;
retry pending synchronization with explicit `sync`. New operation-ID revisions
remain eligible. There is no sync on recall, search, status, startup or init, no
timer and no permanent daemon. Direct internal `MemoryEngine` calls remain
local; the CLI owns automatic policy dispatch.

A changed automatic scope can produce at most one source commit per successful
mutation command; a divergent history can additionally produce a merge commit.
Unchanged sync creates no empty commit and does not push an identical head.
Unavailable remotes are detected before staging local additions, allowing later
sync to batch offline changes. Source and repository validation intentionally
remain conservative; synchronization is not a constant-time operation.

Failed automatic sync returns the saved memory with a `SYNC_PENDING` warning and
`synchronization` reports; the mutation still succeeds. It does not undo or
duplicate a saved revision. Explicit failed sync exits nonzero.

Imported revisions invalidate the derived search corpus; the next engine query
validates/rebuilds its SQLite index as needed. No database is synchronized.

## Results, offline use and recovery

`sync --json` returns `{ok, trigger, results}`. Each result contains selected
`scopes` (path, scope, mode, optional project/session ID), optional
`repository`, `remote`/`branch`/`commit`/`recoveryRef`, `stage`, `status`, and
optional actionable `code`/`message`. Status is `skipped`, `up-to-date`,
`committed` (commit-only), `synchronized`, `pending`, `conflict`, or `error`. A
pull-only update counts as synchronized. Per-repository failures do not prevent
another independent repository from reporting its result.

Operational sync failures return the report on **stdout** with exit 1; usage,
configuration and scope-selection errors retain the normal error envelope on
stderr. Automatic warnings preserve mutation exit 0. Explicit sync handles
SIGINT/SIGTERM through cancellation and reports interruption (exit 130). Git
commands time out after 15 seconds locally/30 seconds for transport; diagnostic
output is bounded and raw stderr is withheld because it can contain credentials.

Examples of recovery:

- `UNRELATED_CHANGES` / `UNRELATED_HISTORY`: inspect `git status` and outgoing
  history yourself. Commit/review unrelated changes, synchronize them yourself,
  or choose a dedicated memory repository. No reset/stash is performed.
- Offline/authentication/timeout/push rejection: keep working locally. Fix Git
  connectivity/credentials or server policy, then rerun the same explicit sync.
  Existing local commits are reused; a remote advance is fetched and validated.
  A lost push acknowledgement can leave the remote already updated even while
  the client reports pending; retry reconciliation rather than forcing anything.
- `IMMUTABLE_CONFLICT`: preserve both same-path versions and the fetched ref.
  Review corruption/identity or line-ending/format discrepancies; Membrain
  cannot choose which source is authoritative and never replaces one
  automatically.
- `SEMANTIC_CONFLICT`: preserve both histories. Inspect the reported ref with
  `git log <recovery-ref>` / `git ls-tree -r <recovery-ref>` and local
  `membrain list --history --status all`. Since incoming files are not imported
  before validation, local list alone may show only the local head. A Git text
  merge by itself does not resolve competing memory revisions. Advanced owner
  recovery must retain every ancestor and append a reviewed valid revision whose
  `parentRevisionIds` join all competing heads, with the same memory identity
  and a timestamp after every parent. For delete/update races, preserve deletion
  unless restoration is explicitly chosen as a new memory. Publish under the
  store lock, then retry. Tests exercise this using
  `writeStore`/`appendRevision`; a user-facing conflict-resolution command
  remains future work. Do not edit or delete an immutable ancestor to make an
  error disappear.

The last fsynced progress snapshot is
`<git-common-dir>/membrain-sync/progress.json`, with stages such as fetching,
fetched, staging, staged, committed, merging, merged, pushing, pushed, complete.
It is diagnostic; authoritative state is source files plus Git refs/index.
Failure refs are retained for inspection (a failed fetch may not have populated
its allocated ref). Successful attempts delete only their own recovery ref.
Crash-left private indexes/temporary files/recovery refs are never stolen or
deleted as a general cleanup operation.

There is no atomic transaction spanning Git refs, index, filesystem and remote.
After hard termination, verify no process is alive before manually inspecting
any `.membrain-lock`, Git `index.lock`, temporary index or progress file. Never
remove another live owner's lock. Git/source state makes retries idempotent;
power-loss behavior beyond OS/Git guarantees is not certified. Avoid
simultaneous manual Git edits/checkouts while syncing: HEAD/status checks catch
ordinary races and exact-path/private-index commits prevent staging
contamination, but hostile non-cooperating filesystem mutation is outside the
supported model.

Secret detection is heuristic, private Git is not encryption, and Git history
retains deleted content. Review before sharing and rotate leaked credentials. No
automatic conflict resolution, purge, Git history removal, real GitHub
credential provisioning, background retry or agent integration is included. The
[large-store recall release blocker](release-blockers.md) remains open.

Git primitives: [exact-path commits](https://git-scm.com/docs/git-commit),
[private index tree loading](https://git-scm.com/docs/git-read-tree),
[commit-tree](https://git-scm.com/docs/git-commit-tree), and
[fetch isolation options](https://git-scm.com/docs/git-fetch).
