# Installation, package validation, and troubleshooting

Membrain requires Node.js >=24.15.0 and npm. Prefer the latest patched Node 24
LTS. Windows, macOS, and Linux are CI targets; the matrix tests the declared
minimum, latest 24, and 26. Passing a matrix job establishes that runner's
OS/architecture, not every distribution, CPU, network filesystem, or Node major.
See [release-readiness.md](release-readiness.md) for observed results. Node's
[release policy](https://github.com/nodejs/Release) defines maintained lines; an
`engines` range alone is not a promise of untested future compatibility.

The current development version is `0.1.0-dev.0`, with `private: true`. No npm
publication is authorized. On 2026-10-26,
`npm view membrain name version dist-tags --json` returned the existing
`membrain@1.0.0` registration. This does not establish this project's ownership
or publishing permission. The owner must resolve the registry name/ownership or
explicitly choose another name. Do not assume the unscoped name is available or
change it automatically.

## Validate an archive without touching a real global installation

From this repository:

```sh
npm ci
npm run check
npm run pack:check
npm run install:check
```

On restricted Windows PowerShell, use `npm.cmd`; do not change the machine's
execution policy. `pack:check` verifies an exact allowlist without publishing.
`install:check` creates an actual archive, installs it globally **only into a
disposable prefix**, with disposable npm configuration/cache files, and executes
its shim outside the checkout. It tests init, remember/recall, current read-only
retrieval, explicit rebuilding, and exact skill export. It also verifies that
TypeScript, ESLint, and Prettier are absent from the installed runtime. Fixture
paths contain spaces. Its temporary archive, installation, and memories are
removed afterward; the user's global CLI/configuration is not modified.

The package includes compiled `dist/*.js`, documentation, and
`skills/membrain/SKILL.md`, plus package metadata and MIT license. npm includes
the owner's README automatically; its bytes are preserved. Source, tests,
fixtures, `.membrain` data, SQLite files, locks, credentials, and developer
configuration are excluded by the package allowlist. There is no install or
postinstall integration script, automatic activation, or required account.

## Native SQLite

The lockfile uses `better-sqlite3@13.0.3`. Its package contains platform
prebuilds and uses Node-API; it depends on `node-addon-api`, rather than the old
`prebuild-install` installer. Review the installed package metadata and the
[upstream releases](https://github.com/WiseLibs/better-sqlite3/releases) before
making native-install assumptions. The capability tests and installed archive
test must actually load SQLite/FTS5 on each runner. An npm installation success
alone is insufficient evidence of working native bindings.

If native loading fails, check the actual Node version and CPU architecture,
reinstall dependencies with the supported npm/Node version, and consult upstream
build instructions for an unsupported prebuild target. Do not disable antivirus,
weaken filesystem permissions, or enable unrelated lifecycle scripts to make a
test pass. Network shares and live cloud-folder synchronization are not the
supported locking/durability model.

## Cache and permission errors

`status`, help, and version create no memory/index files. Recall/search/list
read and validate source records; they never save or rewrite memories. Missing,
stale, or damaged SQLite indexes need cache-directory creation, a cache lock, a
temporary SQLite generation, and atomic replacement. A valid current index is
opened read-only without those writes. SQLite sort intermediates stay in memory.
Writes to source files remain exclusive to explicit mutations.

Use `--read-only` if internal cache maintenance is forbidden. `INDEX_READ_ONLY`
means the requested scope corpus has no current usable index. Ask for permission
to maintain the internal index or continue without memory; do not silently serve
stale results. `INDEX_UNAVAILABLE` identifies the cache directory and suggests
checking access, space, and installation or selecting a separate writable local
`MEMBRAIN_CACHE_DIR`. That override cannot overlap a source store. Never grant
cache permissions merely because an agent can read memories.

Damaged JSONL is preserved and blocks recall even if SQLite has old matches.
Restore/inspect the source rather than editing immutable revisions. Damaged
SQLite can be regenerated with an ordinary writable-cache read or
`--rebuild-index`. An `INDEX_PENDING` warning after a save means JSONL was
saved; repair the index instead of creating a duplicate memory.
