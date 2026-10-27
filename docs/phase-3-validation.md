# Phase 3 validation and handoff

Observed on Windows x64 with Node 24.19.0 and npm 11.17.0. Linux/macOS checks
remain configured in the existing Node 24 CI matrix; they were not run in this
local session. Root README and the MIT license remain owner-preserved.

## Delivered behavior

Interactive Inquirer setup and `init --non-interactive` now configure all three
independent scopes, custom canonical paths, stable project IDs/optional markers,
and local/manual/explicitly authorized automatic preferences. Default storage
works without Git. Project detection uses only filesystem markers, including
worktree/submodule `.git` files. No agent executable is launched. Claude
Code/Codex detection reports executable/configuration hints; T3 detection is a
runtime hint only. All integration installers remain unavailable.

Configuration remains schema version 1. Validation, config-parent locks,
no-clobber publication, exact backups, snapshot checks and same-directory atomic
replacement protect reruns. Unchanged files keep their original bytes. No memory
migration/deletion or implicit session promotion occurs. See
[initialization.md](initialization.md) for exact flags and recovery limitations.

## Checks and demonstrations

- `npm.cmd ci` succeeded from the lockfile; audit reported zero vulnerabilities.
  npm also reported its allow-scripts advisory for the existing better-sqlite3
  native install. No global approval/execution-policy settings were changed;
  native loading/FTS5 were verified by the test suite.
- `npm.cmd run check` covers README ownership, formatting, linting, strict type
  checking, build and the full `node:test` suite: 52 tests, 51 passed, one POSIX
  permission test skipped, zero failures. The Phase 3 suite adds fresh setup,
  all-scope/custom-path operation, legacy exact-byte preservation and backup,
  reruns, dry runs, cancellation, authorization renewal/decline, malformed
  config/markers, aliases, collisions, competing setup plans, existing-store
  identity, nested repositories, clones and agent detection.
- The production prompt adapter/wizard is exercised with Inquirer's terminal
  testing streams. A separate live Windows terminal demonstration selected all
  three scopes, accepted their default paths/local policies, confirmed the
  non-Git root, reviewed the marker/configuration, saved, and returned JSON
  `status: "initialized"`. No agent integration was installed.
- `npm.cmd run demo:init` creates temporary custom global/project/session
  directories, configures a non-Git project from nested cwd, saves one memory
  per scope, recalls the project memory, verifies global access outside the
  project and explicit session isolation, and reruns init. The rerun reports
  `unchanged`; config bytes and all three memory IDs remain intact. Its child
  commands run with an empty PATH, so no Git executable is available.
- `npm.cmd run pack:check` validates the built package allowlist with npm's dry
  run. Nothing is published. Tests/demonstrations use temporary data, never a
  developer's memory/configuration.

The POSIX chmod permission-denial test is skipped on Windows (and root POSIX
runners). Windows tests cover blocking files, reserved filenames, missing roots,
junction canonicalization and overlaps. File-symlink tests skip that portion
where the host denies creating them. UNC shares, Windows ACL denial, actual
macOS/Linux filesystem behavior and real agent-version compatibility still need
observed platform checks; fixtures do not establish those results.

The root README SHA-256 remains
`DB6A7E633DA53174D7B3F4B05E4C9DB0694C797DC69AEC1826A8712766349A48`; LICENSE
remains `FF646D5149F73AA01F396259B0B74CFFCB213DFE9F1C5AEF74238C4A22A54D94`. Git
HEAD remains `c455a146a743923f2e64562291c2453a2a8de25c`. No commit, push, PR,
repository initialization, Git synchronization or publication occurred.

## Remaining gates

Phase 4 can build on validated per-scope policies, stable identities and config
receipts. It must validate actual repositories, exact managed files and outgoing
history before any Git mutation; current policy flags do not implement sync.
Agent skills/hooks stay in Phase 5.

Large-store retrieval remains **release-blocking**. The approximately 19-second
warm measurement is a single engine query that includes JSONL replay/freshness
validation. No search/replay or durable record-format changes were made here.
[release-blockers.md](release-blockers.md) proposes warm CLI recall p95 <=1 s
over 30 measured invocations and cold rebuild/query <=10 s on documented
reference machines. These targets have not been achieved or measured in Phase 3.
Configuration replacement also retains the documented narrow race with editors
that ignore the lock, and setup is not a transaction across directories.
