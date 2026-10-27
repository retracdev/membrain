# Technology validation and open decisions

Reviewed 2026-10-25. Runtime/dependency observations are point-in-time evidence,
not a promise that newer releases have the same compatibility.

## Existing checkout and local environment

The initial checkout contained only the owner-maintained root `README.md` and
MIT `LICENSE`; there was no application, configuration, lockfile, or CI. The
working tree was clean. The local Windows environment reported Node 24.19.0, npm
11.17.0, and Git 2.55.0.windows.5. PowerShell execution policy blocks npm's
`.ps1` wrapper; `npm.cmd` works without weakening that policy.

[Node's release schedule](https://github.com/nodejs/Release#release-schedule)
supports the choice of Node 24 LTS as the baseline. Use the latest patched 24.x
for new installations rather than treating the locally installed patch as the
recommended security baseline. Node 26 is not required for the foundation.

## CLI, prompts, and development tooling

[Commander](https://github.com/tj/commander.js) documents LTS support and a Node
minimum compatible with Node 24. npm metadata reported Commander 15.0.0 and its
MIT license. It is the only foundation runtime dependency.

[Inquirer](https://github.com/SBoudrias/Inquirer.js) offers modular terminal
prompts. npm metadata reported `@inquirer/prompts` 8.7.4 with a Node range that
includes the installed runtime. Phase 3 adds `@inquirer/prompts` 8.7.4 and
`@inquirer/testing` 3.3.15 (development only). Both are MIT and their declared
Node engine ranges include Node 24. Prompts load only for interactive init;
memory commands and non-interactive init do not load terminal UI modules.

Registry validation found TypeScript 7.0.2 as the current default, while
typescript-eslint 8.72.0 declares a TypeScript peer range below 6.1.0. The
foundation therefore pins the compatible TypeScript 6.0 patch line instead of
installing incompatible latest majors. The package lock records actual resolved
versions. Recheck compatibility when upgrading. Primary project references:
[TypeScript](https://www.typescriptlang.org/docs/),
[typescript-eslint dependency support](https://typescript-eslint.io/users/dependency-versions/),
and [Node test runner](https://nodejs.org/api/test.html).

The CI action versions follow the inspected official
[checkout](https://github.com/actions/checkout) and
[setup-node](https://github.com/actions/setup-node) documentation. CI installs
from the lockfile, grants read-only repository permission, and performs no
publication or synchronization.

## Phase 2 SQLite driver decision

The
[versioned Node 24.19 SQLite documentation](https://github.com/nodejs/node/blob/v24.19.0/doc/api/sqlite.md)
marks `node:sqlite` as Stability 1.2, release candidate. Its synchronous API
suits a short-lived, local CLI and avoids a native npm install dependency. The
Phase 1 capability check proved FTS5 availability. Its release-candidate API
status remains a maintenance risk for a production dependency boundary.

[SQLite FTS5](https://www.sqlite.org/fts5.html) specifies BM25's lower-is-better
ordering and configurable column weights. Those semantics inform the proposed
documented ranking. Do not combine independent scope BM25 scores as though they
were from one corpus.

Decision: select [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
13.0.3, prioritizing its established synchronous API and ecosystem over avoiding
a dependency. Registry metadata declares Node >=22 and MIT; Membrain retains its
stricter existing Node >=24.15 baseline. The installed 13.x package contains
Node-API binaries for Windows x64/ARM64, macOS x64/ARM64, and Linux glibc/musl
x64/ARM64. On this Windows x64 Node 24.19 runtime, install/native loading,
FTS5/BM25, persistent file indexes, corruption recovery, and concurrent
subprocess tests succeeded without compiling an addon. The required binaries are
in the npm package; runtime use needs no download. The existing three-OS CI runs
those tests on Node 24; macOS/Linux execution is not yet observed locally.

Node's built-in option would eliminate the external native-package lifecycle and
follows the Node distribution's platform coverage, but it ties SQLite/API
updates to the runtime and still exposes the inspected release-candidate API.
better-sqlite3 adds a native release/SQLite maintenance responsibility and does
not promise arbitrary architectures, libc variants, or future runtime support.
Recheck binary support and security updates when upgrading; unsupported targets
may require a separately validated source build. No automatic fallback silently
switches drivers. The production driver is isolated in `src/index/search.ts`.
Neither choice makes JSONL publication or Git synchronization atomic.

## Git and agent integration findings

[Git commit documentation](https://git-scm.com/docs/git-commit) describes path
selection, but staging only owned paths does not prove a push contains only
Membrain changes. Outgoing commits and shared-repository state need separate
validation. Independent scope policies must also be enforced when scopes share
one repository. This is why v1 should refuse unrelated dirty/staged/outgoing
changes before adding more elaborate worktree handling.

Official OpenAI documentation describes
[AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [skills](https://learn.chatgpt.com/docs/build-skills). Anthropic separately
documents [Claude Code skills](https://code.claude.com/docs/en/skills) and
[lifecycle hooks](https://code.claude.com/docs/en/hooks). These are distinct
integration surfaces. Support instruction/skill-driven CLI use first, with
capability-tested hooks where appropriate. Installation formats and lifecycle
behavior must be revalidated during Phase 5; no agent compatibility is claimed
from documentation review alone.

The driver and immutable revision layout are now selected and implemented. The
scale/durability measurements and remaining release gates are recorded in
[phase-2-validation.md](phase-2-validation.md). Supported agent versions remain
a Phase 5 decision; no integration was installed during Phase 2.
