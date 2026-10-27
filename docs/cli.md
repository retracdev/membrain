# CLI reference and remaining command designs

## Available now

Help, version, read-only status, interactive/non-interactive init, Git sync,
portable skill export, and all six memory commands work. See
[initialization.md](initialization.md) for setup and
[memory-engine.md](memory-engine.md) for implemented flags, JSON envelopes,
end-to-end examples, ranking, rebuild/recovery, and limitations. Only `doctor`
returns `NOT_IMPLEMENTED`. See [git-synchronization.md](git-synchronization.md)
for implemented sync/automatic behavior. Run the built entry point as
`node dist/cli.js` until locally linked/installed.

Global options:

- `--config <path>` selects a local configuration file.
- `--json` returns data as JSON on stdout; errors are JSON on stderr. Successful
  non-interactive commands leave stderr empty. Interactive init prompts use
  stderr even with JSON output. Help/version intentionally remain plain text.
- `--help` explains implemented and planned commands.

Status validates and reports the effective configuration, selected config path,
whether it exists, `synchronization: "available"`, and
`skillExport: "available"`. The latter reports export support, not an installed
agent integration. Status reports configured project mappings; memory commands
resolve current project context. Status does not create files, inspect a remote,
infer Git state, or synchronize anything.

```sh
membrain --help
membrain status --json
membrain --config ./membrain-config.json status
```

Exit codes: `0` success/help/empty results, `1` configuration or operational
error (including planned commands), `2` invalid CLI usage, `130` interactive
prompt interruption. Current error envelope:

```json
{
  "error": {
    "code": "INVALID_CONFIG",
    "message": "Configuration version: only schema version 1 is supported."
  }
}
```

Codes include `INVALID_CONFIG`, `CONFIG_READ_FAILED`, `USAGE_ERROR`,
`NOT_IMPLEMENTED`, and `INTERNAL_ERROR`. Consumers must use codes rather than
matching prose. Current memory envelopes are documented in `memory-engine.md`;
pre-release output is not yet a stable public API.

## Retrieval options

Retrieval options: `recall`, `search`, and `list` accept `--read-only` to
require a current SQLite index without cache writes. It cannot be combined with
`--rebuild-index`. Ordinary reads also avoid cache writes when the index is
current. These flags never authorize source mutations. Search and recall accept
`--literal` to keep English function words in technical queries; see
[search-relevance.md](search-relevance.md).

## Portable skill export

`membrain skill export --output DIRECTORY [--overwrite] [--json]` exports only
`DIRECTORY/SKILL.md`. A destination is required; missing directories are
created. No configuration, Git, agent lookup, or installation is involved.
Different existing content requires explicit `--overwrite`; identical exports
are unchanged. Other files are preserved and directory symlinks/junctions are
refused. See [manual integration and export contracts](agent-integrations.md)
for JSON results, safe path behavior, manual installation/removal, and
limitations.

## Command contracts and future setup/synchronization design

The six memory commands, `init` and `sync` below are implemented; `doctor`
remains a future-phase design target. Prefer explicit flags for agents. Missing
choices fail clearly without prompting. The implemented reference in
`memory-engine.md` and command `--help` take precedence over future targets.

- `init`: interactive scope selection, custom locations, independent sync modes,
  project detection, agent availability hints, validation, and a preview.
  Implemented flags: `--non-interactive`, `--global-path PATH`,
  `--project-path PATH`, `--project-root PATH`, `--session-path PATH`, and
  independent `--global-sync`, `--project-sync`, `--session-sync` choices
  (`local|manual|automatic`). Omitted scopes remain disabled; newly selected
  scopes default local. Non-interactive automatic choices require the
  corresponding `--authorize-global-auto-sync`, `--authorize-project-auto-sync`,
  or `--authorize-session-auto-sync` flag, with explicit target settings.
  `--overwrite-config` authorizes config replacement with an exact backup;
  `--dry-run` previews without writes. Repository creation and integration
  installation are unavailable. `--yes` accepts safe defaults only. Never enable
  all scopes or actions merely because an agent passes `--yes`.
- `remember <content>` or `remember --stdin`: require content, accept
  `--scope global|project|session`, `--type`, repeatable `--tag`,
  `--source-agent`, and `--operation-id`. Default writes to current configured
  project; require an explicit scope outside it. Session writes require
  `--session ID`. Noninteractive writes fail on secrets/ambiguity rather than
  silently selecting another scope. Stdin avoids placing sensitive context in
  process arguments/shell history.
- `recall <query>`: enabled global/current project/explicit session only;
  default five results and a 4,000-character serialized-results budget. Accept
  `--scope`, `--project`, `--session`, `--limit`, and `--max-chars`. Include
  provenance and truncation metadata; frame all content as untrusted reference
  data.
- `search <query>`: same deterministic literal-keyword FTS5/BM25 ranking;
  default ten results, maximum 100. Same scope/project/session filters; explicit
  broad searches may use `--all-projects`. Session queries still require an
  explicit session ID; there is no `--all-sessions` flag. Default active records
  only.
- `list`: filtered, bounded metadata without a query. Accept `--scope`,
  `--project`, `--session`, `--status`, `--limit`, and explicit `--history`.
  Conflicting heads are visible for diagnosis and excluded from normal recall.
- `update <id> <content>` or `update <id> --stdin`: creates a revision of the
  same ID. Agents supply `--expected-revision ID` for concurrency protection.
  Content/type/tags may change; moving scope uses explicit promotion/copy, never
  a silent ID/path change.
- `forget <id>`: writes a logical deletion tombstone; does not promise erasure.
  Interactive confirmation or explicit `--yes` is required. Session batch
  discard requires `--scope session --session ID --all --yes`. No automatic
  permanent purge or Git history rewriting.
- `remember --promote <id> --to project|global --session ID`: explicit session
  promotion. Returns destination ID and origin metadata; retry-safe operation ID
  and verified destination precede any optional source deactivation.
- `sync`: explicit synchronization only of selected manual/authorized automatic
  scopes (`--scope`, `--project`, `--session`). Local scopes are skipped in an
  all-eligible run, and an explicitly selected local scope fails with
  configuration guidance. No one-command override that silently upgrades local
  policy. Report `no-remote/commit-only`, `up-to-date`, `pending`, `conflict`,
  `offline`, `authentication-failed`, and per-location partial success. Never
  force-push or include unrelated files/history. The implemented reference in
  `git-synchronization.md` takes precedence over prospective status labels here.
  Operational failures return a per-repository JSON report on stdout with a
  nonzero exit; selection/configuration/usage errors remain on stderr.
- `status`: expands to current scope/project/session resolution, index
  freshness, pending sync and conflicts. Local mode still invokes no Git for
  storage; Git enabled status checks are read-only and do not contact remotes by
  default.
- `doctor`: checks runtime, config, permissions, record integrity, index rebuild
  readiness, and supported agent capabilities. Local-only scopes work without
  Git installed. `--git` explicitly requests eligible Git diagnostics; no
  network unless separately requested. Repairs/installation are explicit
  operations, not side effects of diagnosis.

Filtering never implies permission to create, promote, delete, install, or sync.
Human text stays concise; JSON must carry equivalent IDs, scope and relevance
metadata, limits/truncation, and warnings without decorative terminal
formatting. See
[the architecture](architecture.md#index-and-deterministic-retrieval) for the
ranking specification.
