# Installation and local memory quick start

Membrain is under development. Phase 3 implements interactive/non-interactive
initialization alongside local memory CRUD, scope/session isolation, and SQLite
FTS5/BM25 retrieval. Phase 4 adds optional Git synchronization. Agent
installation remains future work. Nothing needs an account, API key, provider,
GitHub connection, or hosted backend. Root README is maintained separately by
the owner.

## Requirements and local development

Install a current patched Node.js 24 LTS (minimum 24.15.0) with npm. Git is
needed for contributing and the repository ownership check, but is not required
to run any local memory command. Windows, macOS, and Linux are intended targets;
see CI for automated platform coverage.

From this checkout:

```sh
npm ci
npm run check
npm run pack:check
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js status --json
```

On Windows PowerShell, if the npm `.ps1` wrapper is blocked, use `npm.cmd` in
place of `npm` for these commands. Do not change the system execution policy.

`npm run check` includes formatting, linting, strict type checking, tests, and
the README ownership guard. Tests use temporary directories and an in-memory
SQLite capability probe; they do not use your actual memories or edit user
config. The engine uses better-sqlite3 rather than Node's release-candidate API.

For a local CLI link, after building, you may run `npm link` and then
`membrain --help`. This creates a global development link;
`npm unlink --global membrain` removes it. It does not install agent
integrations. Check the linked executable with `where.exe membrain` on Windows
or `command -v membrain` on POSIX. On restricted PowerShell use `membrain.cmd`
if its generated `.ps1` shim is blocked.

There is no release installation promise yet: do not assume an existing npm
package with this name belongs to this project. Phase 6 validates the registry
name, packed installations, and release metadata before publishing.

## Configure memory

Run `node dist/cli.js init` for the terminal wizard. Confirm the project root,
choose independent storage directories and keep local-only defaults unless you
want to enable optional synchronization. Init itself runs no Git or agent
integration. For automation, select scopes explicitly:

```sh
node dist/cli.js init --non-interactive --global --session --json
node dist/cli.js init --non-interactive --project-root /path/to/project --overwrite-config
```

The second command adds the project while preserving the first command's scopes;
it backs up the existing config before replacing it. Custom paths, consent and
reinitialization are documented in [initialization.md](initialization.md).

To exercise read-only status instead, you can still create your own
`membrain-config.json` in a scratch directory:

```json
{
  "version": 1,
  "global": { "path": "./fleet-memory" },
  "projects": [],
  "session": { "path": "./sessions" }
}
```

Run:

```sh
node dist/cli.js --config /absolute/path/to/membrain-config.json status --json
```

Quote paths containing spaces. Storage paths resolve relative to the config
file, never whichever nested cwd an agent happens to use. Both scopes normalize
to `sync.mode: local`. Status neither creates these directories nor interacts
with Git. Manual policies synchronize only via `sync`; authorized automatic
policies may synchronize after later CLI mutations. See the
[configuration design](architecture.md#configuration-and-synchronization-policy)
for all three per-scope modes and authorization rules.

Without `--config`, `MEMBRAIN_CONFIG` overrides the OS default. Default config
is under `%APPDATA%/membrain` on Windows or `$XDG_CONFIG_HOME/membrain` on
POSIX, with the documented fallbacks. Global memory itself can live anywhere you
choose; it is not required to live alongside this configuration file.

Next: follow the working CRUD/session/rebuild examples in
[memory-engine.md](memory-engine.md), then read [CLI contracts](cli.md),
[architecture](architecture.md),
[implementation phases](implementation-plan.md), and
[optional portable skill](agent-integrations.md). For Git setup, supported
files, automatic consent and recovery, read
[Git synchronization](git-synchronization.md). Skill export requires an explicit
destination (`membrain skill export --output ./review/membrain`); review and
installation are manual. Membrain never installs skills or hooks for you.
