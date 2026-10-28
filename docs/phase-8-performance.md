# Phase 8: incremental indexing and explicit fast recall

Status: implementation under validation; the one-second release gate is not
claimed. Strict verification remains the default. See
[index-freshness.md](index-freshness.md) for the exact fast-mode limitation.

## Architecture and root cause

Phase 7 repeats directory traversal and per-revision
metadata/read/validation/hash work before each query. SQLite ranking is
secondary. Phase 8 explicit fast mode enumerates actual paths and reuses
validated history, validates new revisions, rechecks graph/scope identity,
incrementally projects affected memories and verifies returned bytes. SQLite
schema 2 checkpoints remain disposable and local. Maintenance updates a private
copy transactionally, validates it, then publishes atomically; interrupted
maintenance cannot expose partial entries or FTS state. No dependency,
source/config migration, Git journal, service or daemon was added.

Strict remains the compatibility default because fast cannot detect all
unreturned in-place edits, including same-size edits with restored timestamps.
New/removed filenames are checked without timestamp trust. Returned modified
bytes fail; removed indexed tombstones cannot expose retained older heads.
Without a prior cache, the engine cannot prove an otherwise valid source's past
history. Full verification/recovery remains linear in revision count.

## Reproduction and measurement boundaries

```sh
npm ci
npm run check
npm run benchmark:suite -- phase8-baseline 100,1000,10000 30 global
npm run benchmark:suite -- phase8-fast 100,1000,10000 30 fast --gate
npm run benchmark:suite -- phase8-strict 10000 30 global
npm run benchmark:suite -- phase8-large 50000 3 fast
npm run pack:check
npm run install:check
```

Baseline requires the unchanged Phase 7 build at ac16766; final commands require
the Phase 8 build. Reports/raw logs remain under ignored coverage/performance.
All source/config/cache fixtures are disposable OS temporary directories.
Benchmarks never load personal memory. No published/global CLI is invoked.

The corpus, query, five-result/4,000-character budget and independent CLI
processes match Phase 7: seven topics, tags/metadata and two revisions per
active memory, with fresh UUIDs. One excluded warmup precedes sequential warm
samples; none may rebuild. Measurements include
startup/import/config/verification, SQLite, output and exit. `--version` startup
is measured separately. Baseline and final batches are sequential, not
simultaneous, on the same desktop; normal desktop load/antivirus and OS cache
state are uncontrolled. Editing and occasional type checks occurred during
baseline collection. These are comparable recipes, not a controlled causal
speedup experiment. Fast and strict have different byte verification contracts
and must never be described as equivalent guarantees.

Cold means missing index, not evicted disk/OS caches. The first cold sample is
profiled separately; cold p50/p95/p99 use three uninstrumented processes. Warm
p50/p95/p99 use 30 uninstrumented processes except explicitly limited 50k
probes. Nearest-rank p99 is the maximum at n=30; cold/3-sample tails are
exploratory. Separate profiling records maxRSS KiB, API-level filesystem
counts/bytes and spans. Worker counts/times aggregate into the parent and
overlap; they are not physical disk traffic. CLI memory disappears at exit. The
enclosing benchmark process's peak RAM is reported separately from CLI peak RAM.

## Evidence

Reference environment: Windows x64, OS release 10.0.26220, Intel Core i7-7600U
2.80 GHz (four logical CPUs), 16 GiB RAM, Node v24.19.0, npm 11.17.0.
Measurements were made on the normal desktop, without changing antivirus/indexer
settings or evicting OS caches. Storage/controller performance was not
independently measured. The 10k baseline completed at 2026-10-28T03:54:40.552Z
(October 27 locally).

Results and validation are filled in after the final runs. Historical hosted
Phase 7 p95 values (Linux 1,057 ms, macOS 1,351 ms, Windows 2,423 ms) and
reference Windows 17,128 ms are context, not baseline observations for this run.

The new isolated baseline at 10,000 active/20,000 revisions measured warm p50
15,478 ms, p95 18,225 ms, p99 18,543 ms (30 samples); first cold 18,337 ms and
full replay 18,434 ms. SQLite reuse excluding replay was 279 ms. Warm profiled
CLI peak RSS was 248,568 KiB, with 20,000 source revision reads (11,118,420
bytes), 30,000 worker lstats and 10,000 worker directory enumerations.

## Local validation

Clean `npm ci` passed (130 packages installed, zero audit findings reported).
`npm run check` passed: ownership, format, lint, TypeScript, production build
and 120 tests (117 passed, three POSIX-only permission skips on Windows). This
includes the complete Git synchronization, CLI end-to-end, concurrency, worker,
offline, integrity and scope suites. After review batched session-discard
projection once, focused engine/index/incremental tests passed again: 37 passed,
one POSIX-only skip. Root README and MIT license Git object hashes match main.
All mutations target this repository or disposable fixtures; no command targets
personal memories, external projects, actual global CLI or agent configuration.
Package allowlist validation passed (51 files); isolated tarball installation
passed native SQLite/worker, actual shim, CRUD/rebuild/read-only and explicit
fast recall checks. No development dependencies leaked and nothing was
published. The lexical relevance benchmark passed its regression cases; its
known semantic intent example remains unsupported.

## Remaining release limitations

The default strict latency gate remains open until demonstrated by measurements.
Fast mode still scans directory/file names and materializes cached history; it
does not make filesystem work constant in store size. Writes still fully verify
history before source publication. Private-copy updates trade copying the local
database for simpler crash recovery. Stale-lock inspection remains manual.
Unsupported network/live-cloud filesystem locking, lexical search limitations,
registry ownership and explicit publication authorization remain as documented
release gates. No npm publication, GitHub release or automatic integration is
part of Phase 8.
