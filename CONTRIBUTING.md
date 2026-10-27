# Contributing to Membrain

Membrain is a small local-first CLI for persistent agent memory, licensed under
MIT. Begin with [the architecture](docs/architecture.md),
[implementation phases](docs/implementation-plan.md), and repository
instructions in [AGENTS.md](AGENTS.md).

The project owner exclusively maintains root `README.md`. Do not edit, generate,
rename, move, or delete it, and do not include README changes in a contribution.
Propose README improvements to the owner in your handoff. Put all additional
documentation under `docs/`. Preserve the MIT license.

Use Node.js 24 LTS (at least 24.15.0) and npm:

```sh
npm ci
npm run check
npm run pack:check
```

Use `npm.cmd` on Windows PowerShell if execution policy blocks `npm.ps1`.
`npm run format` formats supported files while explicitly excluding root README.
`npm run build` compiles the CLI; `node dist/cli.js --help` runs it. Full setup
details are in [docs/quick-start.md](docs/quick-start.md).

Keep changes focused and within the agreed phase. Explain resulting behavior,
compatibility decisions, and meaningful validation. New dependencies need a
clear purpose and compatible runtime/license. Use strict types, validate
external data, keep machine-readable errors stable, and separate CLI behavior
from engine code. Test behavior in temporary directories, not real configuration
or memories. Use synthetic secret examples only. Storage/sync work requires
concurrency, crash, conflict, offline, and cross-platform fixtures for the
behavior it adds.

Default every scope to local. Git inside a storage directory does not grant
permission to manage it. Avoid unrelated files/history, implicit
synchronization, MCP, network dependencies for local commands, telemetry, and
destructive repair. Do not publish packages or push changes as part of a
development check.

Before release work, validate packed installations, registry ownership, and
documentation under `docs/`. The owner must separately authorize publishing;
green tests alone do not authorize a release.
