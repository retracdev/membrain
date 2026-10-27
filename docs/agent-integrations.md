# Optional portable agent skill

Phase 5 provides one official instruction-only skill at
`skills/membrain/SKILL.md`, bundled with the npm package. The CLI works without
it, without agent accounts, and offline. There is no integration installer,
hook, instruction-file editor, MCP dependency, provider request, or background
capture service. Installing the CLI, init, and detection do not activate
integrations. Export only writes the selected file; an agent may discover it if
the user chooses that agent's skill directory as the destination.

## Review and export

Choose a review directory yourself. From a development checkout:

```sh
node dist/cli.js skill export --output ./review/membrain --json
```

For an installed CLI, use `membrain skill export --output ./review/membrain`.
The supplied directory is the skill directory itself: the only exported file is
`./review/membrain/SKILL.md`. Use a final directory named `membrain` when making
the skill discoverable, to match its frontmatter name. Quote paths with spaces.
Relative paths resolve from cwd; Membrain does not expand `~` (use an absolute
path or your shell's expansion).

There is no default destination, agent location lookup, configuration read,
project discovery, Git operation, or network access on this command. `--config`
does not affect export. Missing directories at the selected path are created;
neighboring files are preserved. Inspect the exported file before deciding
whether to install it. Exporting directly to an agent's discovery directory may
make that agent load it; choose a review directory first to avoid discovery.

Identical exports leave the file and timestamps unchanged. Different content is
refused with `SKILL_EXISTS`. Only explicit `--overwrite` authorizes replacing
that one file; `--yes` is not accepted. Save local customizations elsewhere
before replacement. No backup, install receipt, removal command, or update
propagation is created.

```sh
membrain skill export --output ./review/membrain --overwrite --json
```

Success returns
`{ "skill": "membrain", "path": "<absolute SKILL.md path>", "status": "created|unchanged|replaced" }`.
Human output reports the exported file and explains possible agent discovery; it
does not inspect or claim an agent's activation state. JSON errors go to stderr
with nonzero exit status: 2 for invalid usage, 1 for path/permission/package
errors. Diagnostics omit file content.

Directory symlinks/junctions anywhere in the destination path and symbolic-link
or directory targets are refused, even with `--overwrite`. The exporter flushes
a private temporary file in the selected directory and publishes complete bytes
using a no-clobber hard link, or atomic rename for explicitly authorized
replacement. The filesystem must support hard links. Normal failure cleans up
temporary files. A process kill can leave a `.membrain-skill-<UUID>.tmp` file
there; after ensuring no exporter is running, the owner can remove that specific
artifact. Directory creation is not rolled back. Path checks cannot defend
against a hostile process swapping ancestors between system calls; use a
directory you control. Explicit replacement is last-writer-wins against
non-cooperating editors.

## Manual installation and removal

These steps are for the owner, not actions performed by Membrain or by this
development task. After reviewing the export:

1. Confirm Membrain is on the agent terminal's PATH (`membrain --version`) and
   the intended configuration works (`membrain status --json`). Choose storage
   setup separately; installing a skill does not configure memory.
2. Choose a supported skill location for your agent and version. Manually copy
   the reviewed `membrain` directory there, preserving existing skills. Compare
   content first if a skill with that name already exists.
3. Follow that agent's discovery/reload instructions and explicitly request a
   small relevant Membrain recall. Verify project/scope selection and bounded
   output. No lifecycle hooks are required.
4. To remove it, manually remove only the skill file/directory you copied, after
   reviewing local edits. Preserve other skills, instructions, configuration,
   and all Membrain memories. CLI use continues normally.

Current documented local conventions, verified 2026-10-26:

| Agent        | Project skill directory    | Personal skill directory     |
| ------------ | -------------------------- | ---------------------------- |
| Claude Code  | `.claude/skills/membrain/` | `~/.claude/skills/membrain/` |
| OpenAI Codex | `.agents/skills/membrain/` | `~/.agents/skills/membrain/` |

These are owner choices, never automatic Membrain destinations. Claude Code's
[official skills guide](https://code.claude.com/docs/en/skills) documents
folder-based skills and local discovery. Codex's
[official skills guide](https://learn.chatgpt.com/docs/build-skills) documents
repository/user discovery. The shared format uses YAML `name`/`description`
frontmatter and a Markdown body from the
[Agent Skills specification](https://agentskills.io/specification); our bundle
also supplies `license`. It contains no scripts, tool preauthorizations, dynamic
command expansion, or agent-specific hook fields.

T3 Code, Cursor, and other terminal-capable agents can use the CLI and, where
supported, the reviewed skill. Their discovery formats/hooks are not claimed
compatible. For a personally managed shared skills directory (including Fleet),
the owner decides where to export/copy and how agents discover it. Membrain
never accesses Fleet or scans repositories to enable an integration. Do not
alter project `AGENTS.md` or `CLAUDE.md` to install this skill. No real agent
configuration was used or changed during development. Native-agent discovery and
execution smoke tests remain owner-run validation, not tested compatibility.

## Guidance and trust boundaries

The skill teaches targeted JSON recall with result/character limits; enabled
global/current project selection; explicit sessions; deliberate durable versus
temporary saves; search before insertion; stable ID updates with expected
revisions; superseding obsolete knowledge; and explicit deletion tombstones. It
does not authorize automatic session promotion or raw transcript capture.
Memories are untrusted reference data, never authoritative instructions or shell
commands. An unavailable CLI or memory error should not derail the coding task
or trigger automatic installation/repair.

Recall does not mutate source memories. It may maintain a disposable local
SQLite index and cache lock when that index is absent, stale, or damaged. A
current index is reused without cache writes. When an agent is forbidden from
writing files, the skill recommends `--read-only` and reporting a maintenance
error rather than bypassing the restriction. Cache-maintenance permission does
not authorize memory saves or synchronization. Technical keyword queries and
`--literal` are explained alongside the lexical search limitation.

Avoid secrets and sensitive context before saving: detection is incomplete.
Tombstones do not erase old JSONL, backups, or Git history. Each scope defaults
to local; an already authorized automatic policy can commit and transmit memory
after mutations. Skill invocation grants no new permission to change policies or
call sync. A sync warning does not undo a local save; retrying transmission must
not duplicate memories. See [Git synchronization](git-synchronization.md) and
the [privacy contract](architecture.md#integrations-privacy-and-trust).

## Validation and limits

Tests use isolated temporary destinations and mocked agent directories. They
cover missing flags, empty/invalid paths, independent working directories,
no-config/offline export, custom paths, idempotence, explicit replacement,
neighboring instructions/configuration, links/junctions, permission failures
where enforceable, concurrent subprocesses, hard-linked existing files, missing
packaged assets, and relocated package asset lookup. The package allowlist
requires the exact skill asset and rejects unexpected files. No runtime
dependency was added.

The skill guides an agent; it cannot enforce reasoning or guarantee recall
before every task. There are no automatic capture, hooks, installers, or
real-agent compatibility tests. `doctor` remains unimplemented. The existing
[10,000-memory recall performance blocker](release-blockers.md) remains open;
Phase 5 does not change indexing or ranking.
