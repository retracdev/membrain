# Phase 6 release readiness

Status: **publication blocked**. Keep `0.1.0-dev.0` and `private: true`. For
subsequent replay performance work and validation, see
[phase-7-performance.md](phase-7-performance.md); the Phase 6 evidence here is
preserved as historical context. Recommend `0.1.0` for the first public release
under a confirmed registry name after the remaining gates pass. This assessment
does not authorize publication, a GitHub release, merging, integration
installation, or infrastructure.

## Resolved issues

- Current-index retrieval no longer requires cache writes or a filesystem lock.
  `--read-only` explicitly refuses missing/stale/damaged indexes. New
  `INDEX_READ_ONLY`/`INDEX_UNAVAILABLE` diagnostics explain internal cache needs
  separately from memory saves. Recall never changes stored revisions.
- Full source hashing, same-size/timestamp-restored tamper detection, malformed
  UTF-8/JSONL refusal, scope isolation, conflicting-head handling, and physical/
  FTS index recovery remain covered. Windows ACL denial and Node permission
  tests demonstrate reuse without writes. POSIX chmod coverage runs on CI.
- A reproduced Windows sharing violation during concurrent index replacement now
  receives a bounded retry under the maintenance lock. A held read-only
  connection regression verifies eventual replacement after the reader closes;
  no old index is unlinked and no permissions are relaxed.
- English function-word filtering and stronger tag weighting improve predictable
  lexical cases. `--literal` preserves all query tokens for technical language.
  The supplied semantic example remains explicitly unsolved; see
  [search-relevance.md](search-relevance.md).
- Deletion help/confirmation explains removal from searches and retained
  synchronization/recovery history. JSON envelopes and explicit `--yes`
  authorization remain intact.
- The portable skill explains lexical queries, index maintenance permissions,
  read-only retrieval, deliberate saves, scopes and untrusted data. Export stays
  explicit, provider-neutral and manual, with no hooks or automatic activation.
- Actual archive installation is automated in disposable global prefixes,
  including command shims, native SQLite, init, save/recall, rebuilding, and
  packaged skill export outside the source checkout. No user's global install is
  used or changed.

## Validation evidence

Local checks use Windows x64, Node 24.19.0, npm 11.17.0, and Git
2.55.0.windows.5. `npm ci` passed with zero reported vulnerabilities;
`npm audit --omit=dev --json` also reported zero at the time of this work. The
three runtime dependencies remain Commander, Inquirer prompts, and
better-sqlite3. No runtime dependency or lockfile upgrade was introduced. The
locked non-development dependency license fields are MIT or ISC, including
Node-API's MIT package. Audit results are time-specific, not a future guarantee.

`npm run install:check` passed locally using an actual generated archive and its
Windows command shim. The isolated installation passed init, remember, recall,
explicit rebuild, current read-only retrieval, and byte-identical, idempotent
skill export. No TypeScript, ESLint, or Prettier runtime installation was
present. Both dry-run and actual archive allowlists exclude tests, fixtures,
personal memories, caches, SQLite, locks, credentials and user configuration.
The archive harness resolves the temporary root before creating its fixture so
macOS's `/var` alias does not trigger the skill export symlink protection. The
export protection itself remains unchanged.

The full check includes ownership, formatting, lint, strict types, production
build and all `node:test` unit, CLI, initialization, memory, concurrency/crash,
skill and Git fixtures. Final counts and measured performance follow below.

Final local `npm run check` passed **99 tests: 96 passed, three skipped, zero
failures** (approximately 449 seconds). The skipped tests exercise POSIX chmod
denial for init, export, and index maintenance; Windows uses the separate
passing ACL/cache-maintenance test and filesystem permission-model subprocesses.
The final actual archive allowlist contains **44 files**. `npm run pack:check`,
`npm run install:check`, and `npm run benchmark:relevance` pass locally.

The CI matrix covers Ubuntu, Windows and macOS at Node 24.15.0, latest 24,
and 26. Each job performs a clean install, full check, package allowlist check,
actual archive installation and relevance benchmark. Configured coverage is not
an observed pass; final PR checks must be inspected before claiming platform
verification. It does not cover Windows ARM64, Linux musl, all architectures,
UNC/network filesystems, every power-loss boundary, or real agent installations.

## Phase 6 performance measurements

The completed 10,000-active / 20,000-revision run on the documented Windows
reference machine measured **warm CLI median 20,851 ms, p95 31,493 ms, maximum
36,767 ms across 30 processes**. Cold-index CLI recall took **18,187 ms**. The
<=1,000 ms warm and <=10,000 ms cold-index gates both **fail**. No unchanged
warm call rebuilt its index. Recall returned five results totaling 2,271
serialized result characters, within the 4,000-character budget.

Source replay took 27,111 ms: enumeration/manifest work 4,946 ms,
read/validate/hash 22,049 ms, and ancestry projection 114 ms. SQLite generation
and query, excluding replay, took 784 ms; SQLite reuse/integrity/hash checks and
query took 168 ms. A durable save with index refresh took 61,153 ms; the next
query found the saved memory in 22,064 ms using its unique `benchmark` term. The
source I/O remains the bottleneck; an SQL-only timing cannot close this gate.

Warm sample durations in milliseconds, in invocation order:

```json
[
  20436, 23223, 20851, 21552, 19225, 21147, 22273, 19813, 20898, 26134, 19192,
  23574, 20325, 24587, 23453, 36767, 19654, 27107, 19477, 19923, 17866, 16604,
  21418, 19466, 22845, 21615, 17555, 17374, 20280, 31493
]
```

The completed run timestamp is 2026-10-27T04:33:43.779Z (2026-10-26 locally). OS
caches were not evicted and desktop/brief validation activity was present. These
observations do not establish a controlled before/after speedup. See
[performance.md](performance.md) for the corpus, methodology and environment.

The 100-active / 200-revision run completed at 2026-10-27T04:34:34.569Z. It
measured warm CLI median **614 ms**, p95 **1,024 ms**, maximum **1,219 ms** over
30 processes; cold-index CLI recall took **1,624 ms**. Small stores are usually
subsecond here, but even this small-store p95 is slightly over one second. It
does not establish the large-store target.

| Measurement (ms)                           | 10,000 active / 20,000 revisions | 100 active / 200 revisions |
| ------------------------------------------ | -------------------------------: | -------------------------: |
| Cold-index CLI recall                      |                           18,187 |                      1,624 |
| Warm CLI median, n=30                      |                           20,851 |                        614 |
| Warm CLI p95, n=30                         |                           31,493 |                      1,024 |
| Warm CLI maximum                           |                           36,767 |                      1,219 |
| Full source replay                         |                           27,111 |                        634 |
| SQLite reuse/check/query, excluding replay |                              168 |                         11 |
| Durable save with index refresh            |                           61,153 |                        439 |
| Next query finding the saved memory        |                           22,064 |                        241 |

Small-store warm samples in invocation order (milliseconds):

```json
[
  1219, 692, 1003, 1024, 713, 514, 591, 593, 875, 764, 933, 589, 571, 532, 686,
  614, 921, 968, 562, 466, 442, 724, 567, 779, 777, 658, 396, 372, 402, 359
]
```

Both benchmark commands completed successfully, including durable-save
visibility and fixture cleanup. The visibility query uses the saved record's
unique `benchmark` term so a broad query's result limit is not mistaken for lost
data. No latency target is claimed as achieved.

## Search regression results

`npm run benchmark:relevance` uses 13 competing memories: **11/11 lexical
regressions pass**, with the original semantic example separately failing as
expected. Previous all-token/tag-0.5 ranking passed 9/11 of those lexical cases.
The database-migrations question now beats a pronoun-heavy unrelated memory;
deliberate release/checklist tags now beat a passing mention. Technical names,
Unicode/diacritics, literal SQL and stable tie/filter behavior remain tested.
These cases are a small deterministic corpus, not a general semantic benchmark.

## Git safety assessment

The synchronization engine was reviewed and retained. Tests cover independent
local/manual/explicit automatic policies, unrelated staged/dirty/untracked work
and outgoing history refusal, exact-path commits, private-index additive merges,
offline retries, multiple repositories/remotes, interrupted stages, secret scans
including history, hook/filter refusal, conflicts and CRLF/LF. An added
regression proves inherited `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE`
cannot redirect an authorized sync into another fixture checkout or index. Only
disposable local remotes are used for these tests. No allowlist, secret scan,
conflict protection, or hook boundary was relaxed.

## Remaining release gates

- The 10,000-memory warm CLI p95 <=1,000 ms gate and proposed cold-index <=10 s
  gate require measured results, below, plus reference measurements per OS. Full
  history verification still scales with file count. This remains a release
  blocker unless evidence meets the threshold.
- `npm view membrain name version dist-tags --json` returned the existing
  `membrain@1.0.0` registration on 2026-10-26. This project has not established
  ownership or publishing rights. The owner must resolve the name/namespace; no
  rename or publication was attempted.
- Observe final CI, review the actual supported runner architectures, and run
  separate macOS/Linux latency measurements. Functional CI cannot prove the
  performance target or every native-install environment.
- A person must authorize publication and any version/private-guard change.
  README links to installation, performance, search limits, and this assessment
  are recommendations for the owner only; no README content was generated.

Known limitations remain lexical intent matching, indefinite retained history,
manual stale-lock recovery, no secure erasure, no compaction/conflict-resolution
CLI, heuristic secret detection, unsupported live cloud-folder/network locking,
and owner-run native-agent compatibility validation. No daemon, MCP, hosted
backend, telemetry, provider SDK, or mandatory model is present.

## Boundaries

Changes and tests stay in this repository and disposable fixtures. No external
project, real agent configuration, global Membrain installation, or personal
memory was modified. The pre-existing untracked `.membrain/` directory is
excluded from changes and packaging. Root README and MIT license retain their
original hashes:

```text
README.md DB6A7E633DA53174D7B3F4B05E4C9DB0694C797DC69AEC1826A8712766349A48
LICENSE   FF646D5149F73AA01F396259B0B74CFFCB213DFE9F1C5AEF74238C4A22A54D94
```

An interrupted exploratory benchmark left a synthetic temporary fixture at
`%TEMP%\membrain-benchmark-iz7ng7`. Automatic approval review rejected cleanup
as "blocked by policy"; it was left intact. It contains synthetic benchmark data
only and is outside the package. Completed validation scripts remove their own
fixtures normally.
