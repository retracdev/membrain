# Phase 8: incremental indexing and explicit fast recall

The observed **10,000-memory fast-mode warm p95 meets 1,000 ms on all three
hosted CI platforms** (30 samples each). The reference Windows machine and the
default strict mode remain over the gate. **Public release remains blocked.**

## Architecture and consistency

Phase 7's dominant cost was opening, validating and hashing every historical
JSONL file before each query. The first Phase 8 experiment avoided those file
reads but still materialized cached history, measuring 5,079 ms reference p95.
The final unchanged fast path verifies one checksum-certified SQLite image,
scans actual revision paths, queries the read-only image, and verifies returned
JSONL. It does not load historical record rows or reconstruct their graph.

Changed inventories validate additions and cached history, then transactionally
reproject affected memory IDs on a private SQLite copy. Full SQLite/FTS
integrity checks precede certification. Atomic database/certificate replacements
can leave a crash mismatch; that mismatch requires complete source recovery.
Normal writes still fully verify source history and reuse their verified writer
snapshot for projection, avoiding a second source replay. JSONL/config remain
schema 1; disposable SQLite is schema 3 with a version-1 local certificate. No
dependency, source migration, daemon, service, model or integration was added.

Strict remains the compatibility default. Explicit `--verification fast` detects
new/removed paths each invocation and checks returned bytes; it cannot audit
unreturned in-place edits. Same-size, timestamp-restored historical edits
require strict verification or explicit rebuild. Proper new tombstones are
immediately visible; missing indexed revisions of retained memories fail rather
than resurrecting older heads. See [index-freshness.md](index-freshness.md) for
external Git changes, crash recovery, permissions, cache portability and the
256-MiB image bound/fallback. Images and source-path enumeration remain linear
in byte/name count; strict audits and writes remain linear in source history.

## Reproduction and methodology

```sh
npm ci
npm run check
npm run benchmark:suite -- phase8-baseline 100,1000,10000 30 global
npm run benchmark:suite -- phase8-final 100,1000,10000 30 fast --gate
npm run benchmark:suite -- phase8-strict-final 10000 30 global --gate
npm run benchmark:suite -- phase8-large 50000 3 fast
npm run install:check
npm run benchmark:relevance
```

Baseline requires the unchanged Phase 7 build at ac16766; final runs use
0a2a274. Raw JSON/logs are retained under ignored `coverage/performance/`. All
source/config/cache fixtures are freshly generated in disposable OS temporary
directories. The installed global shim is tested only in an isolated prefix. No
real memory, global Membrain installation or actual agent configuration is used.

The global corpus matches the Phase 6/7 recipe: two immutable revisions per
active memory, seven topics, tags/metadata, fresh UUIDs, five results and a
4,000-character serialized-results budget. One excluded warmup precedes 30
separate sequential CLI processes; unchanged warm samples must not rebuild.
Startup/import/config/verification/SQLite/output/exit are included. Version-only
startup is measured separately. Baseline and final batches run sequentially on
the same normal desktop; editing and brief type checks occurred during baseline
collection, but full tests are sequenced before final measured batches. Desktop
load, antivirus/indexer activity and OS caches are uncontrolled. These are
comparable recipes, **not a controlled causal speedup experiment**. Fast and
strict provide different byte-verification guarantees.

Cold means missing index, not evicted OS/disk caches. First cold is one profiled
sample; cold percentiles use three additional uninstrumented processes. Warm
percentiles use nearest rank; p99 is the maximum at n=30. The 50k probe uses
only three warm samples, so its tails are exploratory. Preparation/cleanup are
excluded. Profiling runs separately from warm percentiles. API-level filesystem
counts and worker durations overlap and are not physical disk traffic. The
single bounded index-image read is counted separately from JSONL reads. MaxRSS
is KiB from a separate profiled CLI and includes temporary workers; parent
benchmark RSS is listed separately. No process remains after CLI exit.

Reference: Windows x64 release 10.0.26220, Intel Core i7-7600U 2.80 GHz, four
logical CPUs, 16 GiB RAM, Node v24.19.0, npm 11.17.0. Storage/controller
performance was not independently characterized. Baseline 10k completed at
2026-10-28T03:54:40.552Z. Historical Phase 7 hosted p95 (Linux 1,057 ms, macOS
1,351 ms, Windows 2,423 ms) and reference 17,128 ms are context, not controlled
baselines for these runs.

## Reference results

All times are milliseconds. Cold percentile sample count is three throughout.

| Mode            | Memories | Warm n |  Warm p50 / p95 / p99 |  Cold p50 / p95 / p99 | First cold | Warm peak MiB |
| --------------- | -------: | -----: | --------------------: | --------------------: | ---------: | ------------: |
| Baseline strict |      100 |     30 |     936 / 1149 / 1187 |       801 / 810 / 810 |       1171 |          63.2 |
| Final fast      |      100 |     30 |       327 / 489 / 490 |       530 / 566 / 566 |        479 |          63.8 |
| Baseline strict |    1,000 |     30 |    2751 / 3247 / 3818 |    2826 / 2965 / 2965 |       2995 |         193.4 |
| Final fast      |    1,000 |     30 |     803 / 1002 / 1094 |    2609 / 2933 / 2933 |       2707 |         135.8 |
| Baseline strict |   10,000 |     30 | 15478 / 18225 / 18543 | 19420 / 23690 / 23690 |      18337 |         242.7 |
| Final fast      |   10,000 |     30 |    2729 / 3076 / 3418 | 17602 / 18831 / 18831 |      17557 |         207.8 |
| Final strict    |   10,000 |     30 | 15775 / 17346 / 17390 | 18616 / 18972 / 18972 |      17971 |         244.2 |
| Final fast      |   50,000 |      3 | 10129 / 10281 / 10281 | 85991 / 88062 / 88062 |      85526 |         485.7 |

The reference fast 10k gate exited 1: p95 **3,076 ms** versus 1,000 ms. The same
machine's new baseline strict p95 was 18,225 ms. This is a mode-specific
observed improvement; the reference target is **not met**. First cold remains
17,557 ms, so the proposed ten-second cold-index gate is also not met here.

Diagnostics below are separate operations, not additive phases of one
invocation. Index build/reuse diagnostics exclude source replay but include
cache setup, integrity and certificate publication; they are not pure SQL
latency. Save includes durable JSONL plus index refresh; next query is a strict
**engine** query, excluding CLI startup.

| Mode / memories         | Source replay | Index build + query | Index reuse + query | CLI startup p50 / p95 / p99 | Cold CLI peak MiB | Parent peak MiB | Save + index | Next strict engine query |
| ----------------------- | ------------: | ------------------: | ------------------: | --------------------------: | ----------------: | --------------: | -----------: | -----------------------: |
| Baseline strict / 100   |           775 |                 107 |                   9 |             416 / 479 / 488 |              64.7 |            65.4 |          800 |                      434 |
| Final fast / 100        |           361 |                 126 |                   8 |             235 / 360 / 362 |              65.5 |            65.2 |          229 |                      134 |
| Baseline strict / 1000  |          2536 |                 306 |                  68 |             390 / 463 / 493 |             192.9 |           207.3 |         4931 |                     2658 |
| Final fast / 1000       |          2150 |                 422 |                  62 |             222 / 407 / 437 |             194.4 |           214.8 |         2613 |                     1739 |
| Baseline strict / 10000 |         18434 |                1612 |                 279 |             397 / 463 / 481 |             244.6 |           419.5 |        32009 |                    18279 |
| Final fast / 10000      |         17287 |                3030 |                 531 |             307 / 423 / 424 |             245.8 |           426.6 |        18558 |                    14643 |
| Final strict / 10000    |         16343 |                2920 |                 476 |             365 / 435 / 491 |             244.8 |           426.6 |        18889 |                    15456 |
| Final fast / 50000      |         76659 |               15388 |                2699 |             417 / 473 / 473 |             540.4 |           872.7 |        91347 |                    80369 |

At 10k, source JSONL revision reads fall from **20,000 to five** on an unchanged
fast query, plus one **26,873,856-byte** certified index-image read. Worker
memory-directory lstats fall from 30,000 to 10,000; worker readdir calls remain
10,000. Main-thread fast reads include config, certificate, store manifest and
five result revisions (eight readFile calls / 3,243 bytes), plus 26 lstats, five
realpaths and two readdirs. Native SQLite/OS counters have different boundaries;
do not sum them as physical disk operations. Warm profiled CLI peak RSS falls
from 248,568 to 212,776 KiB; startup and filesystem variance still matter.

A paired exploratory inventory-only probe on the reference machine verified
identical 20,000-path hashes across strategies. Three alternating samples were
1,783/1,902/1,917 ms with four workers, 1,936/2,042/1,844 ms with eight, and
6,297/2,170/4,825 ms with equivalent checked asynchronous traversal. These are
component probes, not CLI percentiles or a significance claim. Comparable
latency with fewer VMs motivates at most four inventory workers and available
CPU parallelism; full replay retains its eight-worker global ceiling.

## Hosted CI evidence

[Run 40639314501](https://github.com/retracdev/membrain/actions/runs/40639314501)
measures source head 0a2a274. All nine functional/package and six performance
jobs passed. One Windows/Node 24 dependency-install attempt failed inside
node-gyp before tests began; that job passed on its single retry (attempt 2),
with no test changes or skipped installation scripts. Performance artifacts
remain those completed on attempt 1. Every distribution below uses 30 warm CLI
processes on Node 24. Functional/package jobs cover Node 24.15.0, 24 and 26 on
all three platforms. Benchmarks publish observations; functional green alone
does not establish the latency gate. Raw reports are the run's six performance
artifacts. Hosts differ between runs; historical platform timings are not
controlled causal comparisons.

Hosted fast environments: macOS/Darwin 25.6.0, arm64 Apple M1 (Virtual), three
CPUs / 7 GiB RAM / Node 24.21.0; Linux 7.0.0-1017-azure, x64 AMD EPYC 7763, four
CPUs / 16 GiB / Node 24.22.1; Windows 10.0.26100, x64 AMD EPYC 7763, four CPUs /
16 GiB / Node 24.22.1. Hosted storage is not independently characterized; each
job retains its own full environment in the artifact.

| Platform / arch | Verification |  p50 |  p95 |  p99 | Warm peak MiB |
| --------------- | ------------ | ---: | ---: | ---: | ------------: |
| darwin / arm64  | fast         |  319 |  409 |  415 |         191.7 |
| darwin / arm64  | strict       | 1111 | 1388 | 1421 |         262.0 |
| linux / x64     | fast         |  423 |  481 |  489 |         212.4 |
| linux / x64     | strict       |  561 |  579 |  589 |         315.4 |
| win32 / x64     | fast         |  821 |  836 |  845 |         202.9 |
| win32 / x64     | strict       | 2352 | 2440 | 2448 |         245.2 |

Fast p95 **409 / 481 / 836 ms** (macOS/Linux/Windows) meets the observed hosted
one-second target. Default strict p95 remains over one second on macOS and
Windows in this run. This does not close default-mode or reference-machine
gates.

## Validation and release status

Clean `npm ci` passed (130 packages, zero audit findings reported).
`npm run check` passed ownership, format, lint, TypeScript, production build and
122 tests: **119 passed, three POSIX-only permission skips on Windows**. Engine,
index and incremental checks passed 39/40 with the same POSIX skip; after the
inventory cap, all 24 concurrency/incremental/replay checks passed. Tests cover
cross-process CRUD, tombstones, supersession, promotion, scopes, conflicting
heads, Git additive imports/deletes/conflicts/offline retries,
timestamp-restored edits, corrupt/missing/copied indexes, certificate
loss/corruption, kill recovery at both publication boundaries, permissions and
worker fallback. Original integrity tests remain. POSIX cache-path error
classification found by CI was fixed, preserving INDEX_UNAVAILABLE in both
modes.

Package allowlist and isolated tarball installation passed (**52 files**),
including native SQLite, actual shim, worker relocation, CRUD/rebuild/read-only
and explicit fast recall. No development dependencies leaked. The relevance
benchmark passed **11/11 lexical regressions**; its known semantic intent
example remains unsupported. Root README and MIT license Git object hashes match
main. No external repositories, personal memories, actual global CLI or agent
configuration were modified; fixture integrations remain disposable and
inactive. Nothing was published or released.

Public release remains blocked by default/reference latency and the proposed
cold-index target, plus unresolved registry ownership and separate owner release
authorization. Fast mode's unreturned-byte limitation, linear directory scans,
bounded image memory, full-history write/strict costs, manual stale-lock
recovery, unsupported network/live-cloud locking and lexical limits remain
explicit. No claim of public release readiness is made.

## Primary raw warm samples

phase8-baseline (30 independent CLI processes):

```json
[
  15005, 14924, 15281, 15174, 18543, 15127, 15969, 15115, 18181, 17871, 15665,
  15478, 15279, 15068, 17405, 18225, 16452, 16222, 15770, 15215, 17783, 14859,
  15758, 15447, 14738, 14221, 14929, 16138, 17572, 15783
]
```

phase8-final (30 independent CLI processes):

```json
[
  2713, 2937, 3418, 2976, 2833, 2728, 2824, 2610, 2846, 2625, 2707, 2688, 2729,
  2702, 2749, 2959, 2585, 2716, 2473, 2776, 2731, 2811, 2655, 2899, 2617, 2539,
  2684, 2822, 3076, 2730
]
```

phase8-strict-final (30 independent CLI processes):

```json
[
  15787, 14441, 14880, 14271, 15860, 16282, 15359, 15998, 15949, 15620, 16640,
  15292, 15481, 15927, 15926, 16077, 16593, 15701, 17346, 15392, 15715, 15499,
  15335, 16563, 16287, 16572, 15775, 14517, 15490, 17390
]
```
