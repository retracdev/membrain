# Phase 7: source replay performance

Status: **warm recall target not achieved; Phase 7 and publication remain
blocked.**

## Root cause and measurement boundaries

The unchanged Phase 6 build enumerates every memory directory, checks every
revision's file metadata, reads/decodes/validates/hashes all revision bytes,
reconstructs ancestry, then verifies SQLite and runs FTS5/BM25. The disposable
index was already reused without writes or locks on unchanged reads. The
dominant cost is many small filesystem operations, not SQL ranking.

On this Windows machine, the new pre-optimization 10,000-memory replay took
52,296 ms: 6,304 ms enumeration, 45,849 ms read/validate/hash, 140 ms
projection. Reusing SQLite against that validated snapshot took 454 ms,
including integrity and source-hash comparison; generation plus query took 2,330
ms. Cold-index CLI recall, with local diagnostic instrumentation, took 86,467
ms. These operations are separate measurements, not additive stages of one
invocation.

The historical ~19 seconds measured one Phase 2 warm engine call over shorter
repetitive records. Phase 6's 31,493 ms was the nearest-rank p95 of 30 complete
CLI calls over mixed topics with two revisions per memory. Different corpora,
startup inclusion, statistics, desktop load and filesystem cache state prevent a
causal regression claim. The much slower new baseline on the unchanged build
also demonstrates substantial environment variation. No SQL regression was
established.

## Implemented optimization

At 1,000 or more memory directories per selected store, temporary Node workers
perform checked synchronous traversal and revision reads. This reduces callback
dispatch/promise scheduling and overlaps small-file I/O. A process-wide ceiling
of eight workers covers all concurrent stores. Workers retain regular-file,
symlink, size, UTF-8, JSONL, schema, identity and content-hash checks. A shared
decoder serves both paths. The main thread deterministically sorts revisions,
validates complete ancestry and cross-store identities, then uses the existing
SQLite search/recovery path.

Small stores retain the existing bounded asynchronous path. All workers drain
before return or store-lock release, including failures. Worker denial or
resource failure falls back to a full ordinary replay; partial output is never
trusted. No worker survives replay. There is no daemon, metadata-only cache,
format migration, dependency addition, semantic ranking change, or background
synchronization. JSONL/config schemas and SQLite generation format are
unchanged.

Current generations also avoid a redundant full read of SQLite's stored hash
table: the freshly computed aggregate fingerprint already covers every source
hash and manifest identity. When that fingerprint differs, the existing
per-revision comparison still rejects in-place edits before rebuilding. This
reduces secondary freshness work (83 ms in the 10,000-memory baseline
diagnostic) without skipping authoritative-file checks or SQLite integrity
validation. A zero-row query retains recovery for missing provenance
tables/columns even when the source fingerprint matches.

An exploratory matching-fingerprint fixture (1,000 memories, 2,000 revisions,
three alternating-order rounds) measured original replay at 9,735/9,168/10,236
ms and eight workers at 2,807/2,449/2,643 ms. Sixteen workers measured
3,161/2,667/2,903 ms and increased transient memory. Four workers varied from
2,652 to 5,375 ms. Callback-I/O/concurrency probes were less consistent. These
experiments overlapped desktop/baseline activity and justify a bounded
candidate, not an end-to-end latency or memory release claim.

## Reproduction and statistics

```sh
npm ci
npm run check
npm run benchmark:suite -- current 100,1000,10000 30
npm run benchmark:suite -- mixed 1000 30 mixed
npm run benchmark:suite -- reference 10000 30 global --gate
```

The last command preserves its report and fails if 10,000-memory warm p95
exceeds 1,000 ms. This strict latency gate is separate from ordinary functional
CI. The suite writes JSON/raw logs only under ignored `coverage/performance/`.
All source/config/cache fixtures are freshly generated under the OS temporary
directory and removed after completion. It never loads real Membrain data.

The global benchmark retains the Phase 6 synthetic corpus and end-to-end warm
method: two immutable revisions per memory, seven topics, tags/metadata, one
excluded warmup, five results within a 4,000-character serialized budget, and 30
independent sequential CLI processes. None may rebuild the unchanged index.
Fresh UUIDs change tie identities but not corpus shape. The added `--version`
batch measures import/startup/exit separately. Warm samples have no profiling
subscriber. One additional warm process and the first cold-index process emit
local diagnostics; their instrumentation overhead is outside warm percentiles.
The original first cold-index metric is retained for matching the baseline (one
profiled sample, no cold tail claim). The expanded benchmark additionally
measures three uninstrumented cold-index calls after warm sampling; its cold
percentiles are reported separately and have no matching baseline distribution.
The mixed benchmark independently measures three cold-index processes and 30
warm processes over global, selected/hidden projects and explicit/hidden
sessions with varying types/tags/content lengths. Report stored and selected
corpus sizes separately.

Nearest-rank p50, p95 and p99 are reported with raw samples; with n=30, p99 is
the maximum and is not a precise population-tail estimate. Cold means missing
index, not evicted OS caches. Benchmark preparation/replay warm OS caches. The
before/after recipe is the same, but desktop load is uncontrolled and some
baseline samples overlap exploratory probes/validation. Do not compute a causal
speedup from those end-to-end batches.

Diagnostics use the local `membrain.performance` channel only when subscribed by
the benchmark preloader. No ordinary CLI output, source content, query text,
paths or environment values are sent through that channel. Spans cover command,
config, project/scope selection, source replay, decoding/validation/hashing,
projection, index initialization/integrity/freshness/rebuild, FTS/BM25,
serialization and locks. Worker filesystem counts/bytes/times are aggregated
into the parent; no worker emits its own report. Filesystem operation durations
and nested spans overlap and must not be summed as wall time. Worker directory
traversal/startup falls inside read/validate/hash wall time; the initial
enumeration span covers only root enumeration on that path. Compare complete
source replay, rather than interpreting those different substage boundaries as a
directory-scan improvement. CPU validation totals and filesystem calls retain
their explicit meanings.

Peak RSS is `process.resourceUsage().maxRSS` in KiB for a separate profiled CLI
process and includes temporary worker memory. Heap/RSS at exit, API-level source
read counts/bytes and OS resource counters are also recorded. OS counters vary
by platform and are not physical-disk-byte measurements. There is no idle
process/RAM after CLI exit.

## Consistency and remaining design constraint

Every recall still validates actual source contents; identical size/restored
mtime cannot hide an edit. New/deleted paths, Git imports, tombstones,
supersession, promotions and explicit session discard invalidate the selected
corpus normally. There is no cache expiration interval or stale-cache fallback.
See [index-freshness.md](index-freshness.md) for cross-process/computer and
concurrent-publication guarantees and limitations.

Metadata-only freshness cannot prove arbitrary authoritative bytes are unchanged
across all supported filesystems and external tools. Full verification stays
linear in revision/file count. If the gate still fails, the next justified
experiment is a versioned, compact JSONL segment representation in isolated
fixtures, retaining every revision and independently checking deterministic
rebuild, additive Git compatibility, explicit migration/recovery and old-client
schema refusal. Do not silently migrate existing stores or weaken verification.
File-count reduction needs a separately reviewed source-format decision.

## Windows results and target assessment

**The 10,000-memory warm CLI p95 target fails: 17,128 ms versus 1,000 ms.** The
separate strict gate exited 1 and retained its reports. The proposed cold-index
<=10-second gate also fails. No publication or phase-completion claim is
justified.

Windows 10.0.26220, x64, Intel(R) Core(TM) i7-7600U CPU @ 2.80GHz, 4 logical
CPUs, 16 GiB RAM, v24.19.0; temporary stores on the existing local Windows
filesystem. Antivirus/indexer settings were not changed. Baseline and
post-change observations used the same global corpus, warmup and
process-sampling recipe. Baseline desktop/probe/validation contention differs
from the later batch; these are not controlled causal speedup estimates.

| Batch  | Active memories | Warm n | p50 ms | p95 ms | p99/max ms | First cold ms (n=1, profiled) | Warm diagnostic peak RSS MiB |
| ------ | --------------: | -----: | -----: | -----: | ---------: | ----------------------------: | ---------------------------: |
| Before |             100 |     30 |   1615 |   2910 |       3236 |                          1723 |                         63.5 |
| After  |             100 |     30 |    416 |    732 |        795 |                           532 |                         63.3 |
| Before |           1,000 |     30 |   6848 |  15155 |      18621 |                          8091 |                         75.4 |
| After  |           1,000 |     30 |   2568 |   3028 |       3081 |                          2266 |                        194.2 |
| Before |          10,000 |     30 |  53077 |  95167 |     117783 |                         86467 |                        165.9 |
| After  |          10,000 |     30 |  15780 |  17128 |      18578 |                         16733 |                        244.3 |
| After  |          50,000 |      5 |  70456 |  72049 |      72049 |                         79694 |                        509.6 |

Post-change additional uninstrumented cold-index samples (n=3 per size,
collected after warm sampling):

| Memories | p50 ms | p95/p99/max ms | Raw samples ms      |
| -------- | -----: | -------------: | ------------------- |
| 100      |    717 |            832 | 832, 717, 431       |
| 1,000    |   2798 |           2950 | 2798, 2950, 2794    |
| 10,000   |  17624 |          18759 | 17281, 18759, 17624 |
| 50,000   |  80077 |          84061 | 77115, 84061, 80077 |

At 10,000 memories, separate SQLite generation/check/query excluding source
replay took 1603 ms; reuse/check/query on an already validated snapshot took 282
ms. The profiled cold generation's schema/population transaction took 959 ms;
its complete index-maintenance stage took 1664 ms. Durable save including
refresh took 31677 ms, and the next query verified the saved record in 15712 ms.

The 30 startup-only processes measured p50 433 ms, p95 545 ms, p99/max 605 ms.
Startup alone is a meaningful part of a one-second budget but is not the
dominant remaining cost.

One separate warm diagnostic process (not the p95 sample) measured:

| Stage                                                        | Elapsed ms |
| ------------------------------------------------------------ | ---------: |
| Startup/imports (process elapsed minus command)              |      271.2 |
| Configuration                                                |        9.7 |
| Scope selection (includes project detection)                 |        7.7 |
| Project detection (nested)                                   |        5.8 |
| Complete source replay                                       |    15230.0 |
| Root enumeration (nested)                                    |      209.0 |
| Worker replay, including traversal/startup/transfer (nested) |    14870.1 |
| Projection/fingerprint/ancestry (nested)                     |      147.9 |
| Cross-scope identity checks                                  |       17.7 |
| Complete index reuse/check/query                             |      286.3 |
| SQLite open (nested)                                         |       11.8 |
| SQLite/FTS integrity (nested)                                |      234.8 |
| Index freshness (nested)                                     |        3.5 |
| FTS5 query and BM25 ranking (nested)                         |       11.0 |
| Recall budget                                                |        2.0 |
| Serialization/output call                                    |        1.1 |

Nested rows overlap. Warm lock acquisition/release and index rebuilding occurred
**zero** times. 20,000 decoded/validated/hashed revisions consumed 3255 ms
summed function intervals across workers; this is elapsed time around CPU work,
including scheduler preemption, not OS thread CPU time. Source I/O comprised
10,000 worker directory reads, 30,000 worker metadata checks and 20,000 worker
file reads (11,118,420 source bytes). Summed filesystem durations overlap across
workers. The many file opens remain dominant; skipping JSON parsing alone cannot
recover the remaining ~15 seconds.

The single profiled warm CLI peaked at 244.3 MiB versus 165.9 MiB for the
pre-change diagnostic. These are transient observations, not a maximum across
all 30 samples. There is no idle Membrain process after exit. Worker replay
trades transient RAM for throughput; full verification remains linear in
revision/file count.

### Paired strategy check

`node scripts/benchmark-compare.mjs 1000 5` compares the exact same source/index
with alternating processes and the same Node permission model; only worker
permission differs. Every result/citation/score matches and every warm call
reuses its index. Worker median was 2122 ms; ordinary replay median was 2551 ms
(n=5 each, uncontrolled desktop/OS caches). Raw worker samples: 2187, 1898,
2122, 1995, 2428 ms; ordinary: 2024, 2551, 4059, 3197, 1998 ms. This modest
paired comparison supports the 1,000-directory threshold on this Windows
machine; it is not a 10,000-memory release result or a universal OS guarantee.

### Mixed scopes

| Batch  | Stored memories | Selected memories/revisions | Warm n | p50 ms | p95 ms | p99/max ms | Cold n=3 p50/p95 ms |
| ------ | --------------: | --------------------------- | -----: | -----: | -----: | ---------: | ------------------- |
| Before |            1000 | 600/1200                    |     30 |   3244 |   5759 |       6697 | 3893/5055           |
| After  |            1000 | 600/1200                    |     30 |   2065 |   2971 |       3216 | 3343/3847           |
| After  |           10000 | 6000/12000                  |      5 |  10921 |  11713 |      11713 | 13342/14229         |

Hidden project/session partitions are generated but excluded from selection.
These corpus sizes differ from the all-global release fixture and must not be
substituted for its target assessment.

### Primary raw warm samples

Before (n=30), milliseconds:

```json
[
  95167, 83823, 93956, 90463, 70358, 69201, 82815, 81829, 81016, 37112, 21234,
  28546, 22940, 17950, 29152, 117783, 77468, 54778, 33206, 41758, 54878, 43716,
  60259, 61030, 34707, 39637, 40762, 53077, 52773, 44250
]
```

After (n=30), milliseconds:

```json
[
  15803, 15088, 15831, 14867, 15507, 15734, 16206, 15008, 15585, 15852, 17090,
  15184, 16567, 15261, 14824, 16240, 15780, 16817, 16938, 17128, 16575, 18578,
  16295, 16409, 15527, 15961, 15387, 15579, 14601, 15440
]
```

## Validation and readiness

Clean `npm ci` passed with no dependency/lockfile changes. `npm run check`
passed on Windows after the lock follow-up: **105 tests, 102 passed, three
existing POSIX-only skips, zero failures**, including formatting, lint, strict
types, build, CLI, memory, concurrency/crash, permissions, skill and Git
regression suites. New tests cover large-store deterministic replay, the
process-wide worker cap/drain, worker-denied full replay, source tampering,
external tombstones, physical source removal, selected-scope isolation and
rebuild equivalence. The npm test command explicitly discovers
`test/**/*.test.mjs`, excluding generated validation copies without removing any
repository test.

`npm run install:check` and `pack:check` passed with 50 allowlisted archive
files. An actual archive installed into a disposable global prefix passed native
SQLite, shim, init/save/recall/rebuild, read-only use, packaged skill export and
an eight-worker 1,000-memory replay resolved from the installed package.
Development dependencies were absent. `benchmark:relevance` passed 11/11 lexical
regressions; the separate known semantic example remains unsolved.

The existing functional CI matrix covers Windows/macOS/Linux on Node 24.15.0,
latest 24 and 26. A separate three-OS Node 24 performance job reports the
100/1,000/10,000-memory batches as artifacts, without flaky latency assertions
in functional tests. Local validation is Windows only. The PR run on `0939351`
passed all nine functional matrix jobs and all three performance jobs:

| Hosted platform | Node    | 10k warm n | p50 ms | p95 ms | p99/max ms | Profile peak RSS KiB |
| --------------- | ------- | ---------: | -----: | -----: | ---------: | -------------------: |
| Linux x64       | 24.22.1 |         30 |    778 |    829 |        925 |               270232 |
| macOS arm64     | 24.21.0 |         30 |   1072 |   1608 |       1678 |               253824 |
| Windows x64     | 24.22.1 |         30 |   1725 |   1938 |       2343 |               249804 |

Reports are attached to
[CI run 40612542698](https://github.com/retracdev/membrain/actions/runs/40612542698).
These are different machines with no corresponding pre-change baseline; they are
portability/scale observations, not controlled speedups or reference-machine
guarantees. Linux passing one hosted batch does not clear the reference-machine
gate or the Windows/macOS latency concerns.

The duplicate push run on the same commit failed one Windows/Node 26 concurrent
writer test: lock-directory `mkdir` returned `EPERM`. The PR run passed the same
test. A follow-up bounds retries of Windows `EPERM` by the existing acquisition
timeout, covering delete-pending contention without assuming ownership, removing
another lock or changing permissions. Persistent `EPERM` still propagates after
the deadline; `EACCES` and non-Windows `EPERM` still propagate immediately.
Deterministic tests inject transient and persistent permission errors; all
actions require successful `mkdir` and the existing ownership token checks. This
does not change the warm read path or the recorded benchmark observations. The
observed error is consistent with Windows deletion waiting for open handles
([Microsoft's directory deletion contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectorya));
the precise OS cause of that individual hosted failure was not traced.

Source JSONL, schema-version-1 config, immutable history, Git safety and lexical
ranking remain compatible. Root README and MIT LICENSE retain their initial
SHA-256 values; real personal memories, global agent settings, other
repositories and the actual global CLI installation were not modified. Nothing
was published or released.

**Phase 7 remains open; publication and advancement beyond the performance gate
remain blocked.** The next technically justified work is an isolated
compact-JSONL representation experiment and explicit migration/recovery design,
retaining every revision and Git compatibility. Do not weaken source
verification or introduce a daemon to pass the gate.

The 50,000-memory scale probe preceded the final constant-time provenance-schema
guard; it exercises the same unchanged verified source-reader path and
healthy-index fingerprint check. It is an additional scale observation, not the
final 10,000-memory release-gate batch.
