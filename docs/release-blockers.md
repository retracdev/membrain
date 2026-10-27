# Release blockers and performance targets

## Large-store retrieval: open, release-blocking

Phase 2 measured approximately **18,955 ms for one warm engine query** on
Windows x64, Node 24.19.0. This is unsuitable for routine agent context recall.
Phase 3 audited `scripts/benchmark.mjs`; it does not redesign the search engine.

The fixture contains 10,000 active memories and 20,000 immutable JSONL revision
files (two revisions per ID). `warmSearchMs` brackets exactly one awaited
`engine.query({scope: 'global'}, {query: 'sqlite', limit: 5})`, after one cold
query has built the index. The assertion verifies that the warm call did not
rebuild it. This is neither a repeated-query total/average nor an isolated SQL
timing. The engine still enumerates, reads, validates and hashes authoritative
revision files to verify cached-index freshness before performing FTS5/BM25
retrieval. That integrity work is inside the timer. Earlier replay/cold calls
may warm OS caches; the benchmark does not control cache eviction.

The separately timed process invocation, `cliRecallMs`, measures one complete
`recall` command including startup and bounded JSON output. Phase 2 observed
21,636 ms for that operation. Replay was 25,982 ms, cold search 17,942 ms, and
save including indexing 37,711 ms. These are individual measurements, not p95
statistics. See [phase-2-validation.md](phase-2-validation.md) for the original
context. The benchmark itself generates synthetic memory in temporary storage;
never point a performance fixture at real memories.

Recommended release acceptance targets, to validate before publishing:

- For the same 10,000 active / 20,000 revision fixture on a declared local SSD
  reference machine per supported OS, **warm end-to-end CLI recall p95 <=1 s**
  across at least 30 separate CLI invocations after a warmup, five results and a
  maximum 4,000-character results budget. Record median, p95 and maximum,
  runtime, filesystem, hardware and antivirus/indexer conditions.
- **Cold index rebuild plus first query <=10 s** on those reference machines;
  report cold OS-cache conditions separately rather than calling an existing
  index "cold". Measure mutation-to-visible-query latency and save durability
  separately; an optimization cannot hide pending writes or stale results.
- Preserve concurrent-write safety, source-of-truth validation, corrupt-source
  reporting, deterministic ranking and delete/superseded exclusion. Do not meet
  latency targets by silently trusting stale SQLite or skipping correctness
  checks. Add a repeatable regression probe once an approach is selected.

These are proposed gates, not achieved results. Phase 4 leaves the memory/search
engine and benchmark unchanged; optional sync is dispatched only for mutations,
so ordinary recall still runs no Git. Profile filesystem replay, hashing and
freshness validation separately from SQL before selecting a small
cache/freshness correction or a revised file-count strategy. Any durable-format
change needs an explicit migration design and review. Phase 4 can proceed with
the existing engine, but release readiness remains blocked by this concern and
unobserved platform validation. Phase 3 did not rerun the expensive benchmark
because neither its fixture nor the search/replay implementation changed.
