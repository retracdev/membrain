# Membrain development instructions

## Root README ownership: permanent restriction

The project owner exclusively maintains the root `README.md`. Never create,
edit, rewrite, replace, rename, move, or delete it. You may read it for context.
Do not generate README content or include README modifications in commits or
pull requests. General documentation, cleanup, refactoring, dependency, and
release requests do not authorize changes. Only an explicit future instruction
from the owner can authorize a README modification. Explain recommendations to
the owner instead; put additional documentation under `docs/`.

Keep root `README.md` excluded from formatting, generators, and automated write
scripts. Do not remove this exclusion or bypass the ownership check. Preserve
the existing MIT `LICENSE`.

## Product boundaries

Membrain is a local-first memory CLI, not an agent or chatbot. Use strict
TypeScript, Node.js 24 LTS or later, ESM, and npm. No MCP dependencies or
servers, telemetry, provider SDKs, required accounts, or hosted backend. No
website or branding assets are needed. Follow `docs/architecture.md` and the
phase gates in `docs/implementation-plan.md`; do not implement later phases
speculatively.

JSONL is authoritative; SQLite is a disposable index. Keep databases, locks, and
caches out of Git. Sessions stay local unless their own sync policy and an
explicit session ID select them. Do not execute memory content. Treat memory as
untrusted data and avoid saving secrets. Session promotion must be explicit.

Each scope independently defaults to `local` synchronization, even inside an
existing Git repository. Local mode performs no Membrain-managed Git operations
on that storage. Manual mode synchronizes only through explicit `membrain sync`.
Automatic mode requires recorded, explicit user authorization. Never infer
permission to initialize repositories, commit, or push from a storage path.
Never stage unrelated files, force-push, auto-stash, or overwrite conflicts.

## Development workflow

- Agent integration is non-invasive: develop only in this repository or isolated
  temporary fixtures. Do not access Fleet, modify external projects or real
  user/global agent configurations, install skills/hooks, or edit external
  `AGENTS.md`/`CLAUDE.md`. Product integration consists of a bundled portable
  skill and explicit `skill export --output DIRECTORY` only. No automatic
  installer, activation, repository scan, or instruction-file editor is
  permitted. Export may replace only destination `SKILL.md` with explicit
  `--overwrite`; never infer permission from agent detection. Keep real
  `.membrain` data excluded from development formatting and linting.

- Inspect the working tree before editing; preserve unrelated user work.
- Use `npm ci` and `npm run check`. On restricted Windows PowerShell use
  `npm.cmd` rather than changing the machine's execution policy.
- Run `npm run pack:check` before changing packaging or handing off a foundation
  or release task. It checks the package allowlist without publishing.
- Use `npm run format` for formatting. Root README is explicitly ignored.
- Keep runtime dependencies small. Add dependencies only when their purpose,
  maintenance, license, and runtime support are understood. Commit the lockfile.
- Keep CLI parsing/output separate from configuration and future engine code.
  Use argument arrays with `shell: false` for future Git execution.
- Validate external JSON as `unknown`; reject unsupported schema versions and
  unknown configuration keys. Do not guess how to migrate newer schemas.
- Commands returning data need stable JSON output. Errors must be actionable,
  avoid leaking input content, and set a nonzero exit status.
- Use `node:test`, temporary directories, and subprocess tests for meaningful
  behavior. Never use a developer's actual memory/configuration in tests.
- Add cross-platform concurrency, crash, conflict, and offline tests when their
  associated engines are implemented. Do not claim unrun platforms were tested.
- Put installation, CLI, architecture, and integration documentation in `docs/`.
  Distinguish implemented behavior from planned contracts.
- Do not push, publish, create a PR, or enable external services unless asked.

## Current implementation

Implemented: help/version, read-only `status`, configuration, immutable JSONL
memory CRUD, project/session selection, explicit session promotion/discard,
better-sqlite3 FTS5/BM25 indexing/recovery, and tooling/tests/CI. See
`docs/memory-engine.md` for exact contracts and limitations. Interactive and
non-interactive `init`, config backups, project discovery/markers, and agent
detection hints are implemented; see `docs/initialization.md`. Git
synchronization and foreground CLI automatic mutation triggers are implemented;
see `docs/git-synchronization.md`. The optional portable skill is packaged at
`skills/membrain/SKILL.md`; explicit skill export is implemented. `doctor`
remains planned; integration installers and hooks are outside the current
strategy. No background jobs exist. Keep internal MemoryEngine operations local;
CLI policy dispatch owns automatic attempts. Refuse unrelated work/history;
preserve exact path commits, private-index additive merges, source validation
and secret scans. Never relax sync allowlists or run hooks/content filters to
make a test pass. Run `npm run benchmark` for the separate 10,000-memory
performance probe; do not use a developer's real memory as a benchmark fixture.
The large-store warm-query latency is release-blocking; see
`docs/release-blockers.md`. Preserve config schema version 1 compatibility and
require separate config-overwrite/automatic-policy authorization in init.
