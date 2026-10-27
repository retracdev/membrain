# Initialization and configuration

Phase 3 implements `membrain init`. All storage and setup work offline. No Git
executable, account, provider, or agent installation is required.

## Interactive setup

After building, run `node dist/cli.js init` (or `membrain init` after linking).
The wizard uses modular Inquirer prompts on stderr and needs a terminal on stdin
and stderr. Space toggles scopes; arrows navigate; Enter continues. Ctrl+C
cancels a prompt. Normal cancellation before saving writes nothing.

The wizard detects existing configuration, shows the current project candidate,
asks for scopes, paths and independent synchronization policies, confirms the
project root, optionally creates a portable project marker, and displays the
exact resulting paths/policies before saving. Fresh interactive setup suggests
global and project; session is optional. Existing scopes are preselected;
skipping a scope preserves its configuration rather than disabling/deleting it.

Suggested global/session locations are `global` and `sessions` beside the
configuration file. Global storage may instead be anywhere, including
`~/Code/fleet/memory`. Global selection works outside any configured project.
Project storage defaults to `<confirmed root>/.membrain/project`. Session
configuration selects a base directory; the engine still requires an explicit
session ID and keeps project/session partitions separate. Setup never promotes
session memories.

New scopes default to `local`. Previously selected policies stay selected on
reinitialization; changing a storage location or remote/branch requires renewed
automatic authorization. Managed integrations cannot be selected or installed.
Setup reports Claude Code/Codex executable or configuration-directory hints
without running either agent or reading their configuration contents. T3 Code is
reported only when a T3 runtime environment hint is present; this is not a
standalone installation or version check. No MCP connection is used.

The detection result `integration: "unavailable"` and setup summary
`integrations: "not-available"` refer to managed installation, which remains
unavailable. Phase 5 provides a separate explicit portable skill export; setup
does not run it. See [manual integration](agent-integrations.md).

## Automation

Use `--non-interactive` explicitly. Piped/non-TTY init otherwise fails promptly
with `INIT_REQUIRES_TTY`; `--yes` alone never chooses scopes or permissions.
Path/policy flags select their corresponding scope. `--global`, `--project`, and
`--session` select current/suggested locations. All omitted scopes are kept.
Fresh non-interactive setup must select at least one scope. Existing setup with
no scope flags validates/preserves its configuration.

```sh
# One persistent config, three independent custom stores. Quote paths with spaces.
membrain --config /settings/membrain.json init --non-interactive \
  --global-path /fleet/memory \
  --project-root /code/my-project --project-path /memory/my-project \
  --session-path /scratch/membrain-sessions --json

# Validate and preview without creating anything.
membrain init --non-interactive --global --session --dry-run --json

# Preserve all other scope mappings; save an exact backup of the old config.
membrain init --non-interactive --global-path /new/memory --overwrite-config

# Enable automatic policy for subsequent memory mutations; init itself runs no Git.
membrain init --non-interactive --global-sync automatic \
  --global-remote origin --global-branch memory \
  --authorize-global-auto-sync --overwrite-config
```

On Windows use quoted drive paths such as `"C:\Code\Fleet\memory"` and
PowerShell line continuation or a single command line, rather than the POSIX
backslashes above. UNC paths use native Windows path handling; an unreachable
share fails validation. Network filesystem durability/locking is not certified.
Paths entered through init resolve relative to its current directory, with `~`
expansion. Saved paths are absolute/canonical. Existing relative config paths
retain their original meaning relative to the config file, and unchanged
configuration bytes are preserved. Environment precedence remains `--config`,
`MEMBRAIN_CONFIG`, then the OS-specific config default described in
[architecture.md](architecture.md#configuration-and-synchronization-policy).

Flags in addition to the scope selectors:

| Flag                          | Behavior                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `--SCOPE-path <path>`         | Custom directory for global/project/session                                          |
| `--SCOPE-sync <mode>`         | `local`, `manual`, or `automatic` independently                                      |
| `--SCOPE-remote <name>`       | Existing remote name; URLs/credentials rejected; blank means commit-only             |
| `--SCOPE-branch <name>`       | Portable branch name; required with a remote                                         |
| `--authorize-SCOPE-auto-sync` | Separate authorization of this scope's location/target                               |
| `--project-root <path>`       | Existing codebase root; required for a new non-Git project in automation             |
| `--project-id <id>`           | Optional stable ID; must agree with mappings, marker and existing store              |
| `--no-project-marker`         | Keep local mapping without creating a marker                                         |
| `--overwrite-config`          | Permit replacing an existing config after validation, with an exact backup           |
| `--dry-run`                   | Read/validate/preview only, including proposed directories/files                     |
| `--yes`                       | Skip safe final save confirmation; grants neither overwrite nor automatic permission |
| `--json`                      | Result on stdout; interactive questions remain on stderr                             |

`SCOPE` is `global`, `project`, or `session`. `init --help` lists every flag.
JSON includes `status` (`initialized`, `unchanged`, `dry-run`, `cancelled`),
`configPath`, the normalized version-1 `config`, detection hints, optional
`project`, `createdDirectories`, `createdFiles`, optional `backupPath`, and
`synchronization: "available"`, `integrations: "not-available"`. Dry-run lists
proposed writes in the created-files/directories fields; cancelled setup lists
no writes. Errors use the existing JSON error envelope on stderr. Ctrl+C in a
prompt exits 130; declining a confirmation returns `cancelled`/0.

## Optional synchronization policies

| Policy      | Configuration meaning                            | Current behavior                                                     |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `local`     | Membrain never manages Git for this scope        | Default; filesystem writes only                                      |
| `manual`    | Only explicit `membrain sync` may synchronize    | Git operations only on explicit sync                                 |
| `automatic` | Foreground Git management after explicit consent | Requires `authorized: true`; attempts after subsequent CLI mutations |

Each scope's policy is independent. A containing Git repository does not change
the default. Users may commit memory files themselves while leaving Membrain in
local mode. There is no repository-initialization flag or background job.
Synchronization revalidates repository/file boundaries before using a saved
authorization. No policy authorizes staging unrelated files, force pushes,
repository creation, or remote creation. Remote availability/credentials are
validated during sync, never by init. See
[Git synchronization](git-synchronization.md). Sharing sensitive context needs
care: secret detection is incomplete and deletion cannot erase previously
committed Git history.

## Project identity and detection

Init uses filesystem `.git` directories/files and `.membrain/project.json`
markers, plus existing local root mappings. It runs no Git subprocesses. Nested
commands choose the nearest repository/marker boundary and deepest applicable
configured root. Submodule/worktree `.git` files stop parent-project
inheritance. An unmarked non-Git directory cannot identify its intended outer
root: the wizard asks, and automation must supply `--project-root`.

New project IDs are UUIDs. Existing store identities, configured mappings and
markers must agree; init refuses to reassign populated stores. A portable marker
has only `schemaVersion: 1` and `projectId`, and may be committed by the user. A
moved clone/worktree with that marker can be added as another local root mapping
to the same store. Several candidate stores for one ID require an explicit path.
Marker creation is optional; existing markers are never overwritten, even with
`--overwrite-config`. To relocate an existing populated project store, move/copy
its full authoritative history yourself first, then configure that location.
Init is not a memory migration tool.

## Preservation, concurrency and recovery

Configuration remains schema version 1; existing Phase 2 files remain valid.
Unknown keys/versions and malformed config/markers are rejected, not migrated.
Validation checks directory traversal/write permissions, blocking files,
reserved Windows components, identity conflicts, overlapping scope paths
(including symlink aliases), and target collisions. Existing unrelated files are
retained. Init creates directories and an optional marker/config; store
manifests, revision files and indexes are created by memory commands later.

Plans are read-only. After approval, setup locks the canonical config parent
using the engine's owner/heartbeat directory lock, checks original config and
marker bytes, creates reviewed directories, and probes write/publication
capabilities with private temporary files. It uses exclusive creation and atomic
publication, fsync where supported, and checks ownership before publication.
Changed configuration requires explicit overwrite permission and first saves
`<config name>.<UUID>.membrain-backup`, containing the exact old bytes. The
replacement is fsynced and renamed from the same directory. Fresh files and
markers use no-clobber publication. Repeated unchanged setup keeps the original
config bytes, project ID, policies, memory contents, and unrelated files.

There is no atomic transaction across directories. Config is saved last; a
failure may leave newly created empty directories or a marker. `INIT_PARTIAL`
reports the config and any backup; inspect them and rerun to reuse the marker
ID. No automatic rollback deletes user files. After a killed process, inspect
temporary files and verify no live owner before removing a stale lock manually;
there is no automatic lock theft. Concurrent cooperating initializers serialize
and stale previews fail `CONFIG_CHANGED`/`PROJECT_MARKER_CHANGED`. Raw-byte
checks detect ordinary external edits; an editor that ignores the lock can still
race the final check/rename. Hostile filesystem mutation, network shares, and
power-loss behavior across every filesystem are not certified. Windows directory
fsync limitations remain those of the engine.

Backups may contain sensitive paths/preferences. Protect their directory and
exclude `*.membrain-backup` plus locks/temp/index/session data from your own Git
tracking where appropriate. Init does not modify `.gitignore`, README, license,
agent files, or repository metadata.

See [release-blockers.md](release-blockers.md) for the unresolved large-store
performance gate. Setup scans only small identity/config files, not the full
memory history.
