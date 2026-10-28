# Recall performance and reproducible measurements

Phase 8 results and explicit fast/strict measurements are recorded in
[phase-8-performance.md](phase-8-performance.md). The Phase 6/7 text below is
historical. Strict remains the default; only explicit fast verification avoids
opening every historical revision on unchanged recall. Compare modes by name.

The one-second warm-recall release gate remains open until measured evidence
meets it. SQLite reuse alone is insufficient: every retrieval still reads,
validates, and hashes authoritative JSONL history. No metadata-only shortcut,
stale-cache fallback, background process, or storage-format change was added.

Phase 7 adds bounded temporary replay workers and opt-in local diagnostics. See
[phase-7-performance.md](phase-7-performance.md) for the new measurements,
tradeoffs, and gate assessment, and [index-freshness.md](index-freshness.md) for
the unchanged content-verification contract. The Phase 6 observations below are
historical and must not be treated as a controlled before/after comparison.

## Methodology

```sh
npm ci
npm run benchmark -- 10000 30
npm run benchmark -- 100 30
```

The benchmark creates its own temporary global store/configuration/cache and
runs the CLI from that temporary directory, with an empty Git PATH. It never
uses a developer's memory. The previous benchmark inherited the checkout cwd,
which can select a project marker absent from the synthetic configuration; the
Phase 6 benchmark fixes this isolation bug.

There are two immutable revisions per active memory. Seven recurring topics
cover language preferences, SQLite storage, authentication, testing, deployment,
accessibility, and project build caching. Each current record has a rationale,
tags, and a reviewed-decision sentence; UUIDs are freshly generated. Preparation
and cleanup are excluded from measured durations.

The source replay profile separates enumeration/manifest inspection,
read/validate/hash, and revision-head projection. SQLite measurements reuse an
already validated snapshot: they include index integrity, cached hashes,
generation building/reuse and query, **not source replay**. These diagnostics
must not be mistaken for end-to-end recall times.

Cold CLI recall starts a fresh process with no index in its own cache. It
includes startup, config/scope selection, source validation, SQLite generation,
ranking, bounded recall serialization, and process exit. Fixture generation and
replay warm filesystem caches first: this is **cold index, uncontrolled OS
cache**, not a disk-cold boot measurement. OS caches are not forcibly evicted.

After one excluded warmup, 30 separate sequential CLI processes query the same
unchanged store. The script checks five returned results, a maximum 4,000
serialized result characters, and `index.rebuilt === false` on every measured
warm call. It reports all samples plus median, nearest-rank p95 (29th ordered
sample for n=30), and maximum. Startup, full verification and output are inside
every sample. A final durable save/index refresh and subsequent visible query
are timed separately, after the fixed-corpus warm samples.

## Reference environment and results

Windows 11 Pro Insider Preview 10.0.26220, x64, Intel Core i7-7600U at 2.80 GHz,
four logical CPUs, approximately 16 GiB RAM, local NTFS/NVMe SSD. Node 24.19.0,
npm 11.17.0. Desktop applications remained open. Antivirus/indexer settings were
not changed or controlled. Full tests are sequenced before measured benchmark
queries. Measurements are observations on this machine, not universal bounds.
Brief final Windows regression validation also ran during sampling; these are
normal-desktop observations, not controlled before/after hardware comparisons.

Final measured results are recorded in the Phase 6 validation section of
[release-readiness.md](release-readiness.md). The raw sample count and values
are retained there with the target assessment. macOS/Linux performance needs
separate reference-machine measurements; functional CI does not establish p95.

Historical Phase 2 observations used shorter repetitive records and one warm
engine query, not 30 CLI processes: 18,955 ms warm engine search and 21,636 ms
CLI recall. See [phase-2-validation.md](phase-2-validation.md). Do not compute a
before/after percentage across those different corpora and methodologies.

## Investigation and retained changes

The old engine already reused unchanged SQLite generations. Its dominant work
was full source traversal and read/validate/hash, followed by index freshness
verification. Ordinary reads also created/touched cache directories and a lock
and issued an FTS diagnostic through an INSERT command.

Phase 6 opens current indexes read-only, skips directory creation and locks,
keeps SQLite sorting in memory, and replaces the write-classified diagnostic
with `PRAGMA integrity_check`. SQLite >=3.44 invokes FTS5's `xIntegrity` from
that pragma; see the
[SQLite virtual-table contract](https://www.sqlite.org/vtab.html#the_xintegrity_method).
The native capability test requires that version baseline, and corruption
fixtures check malformed FTS data as well as invalid SQLite bytes. Missing or
stale generations still rebuild under the existing lock with ownership checked
before replacement. No source hashes or graph validation are skipped.

Windows generation replacement retries sharing/permission errors up to 40 times
at 25 ms intervals while retaining the maintenance lock and checking its
ownership. This lets a short-lived native SQLite reader close before
replacement. Persistent denial fails without unlinking the old index or changing
permissions. Ordinary warm reads do not enter this retry path.

Revision reads use one promise around Node's callback `readFile`, retaining
16-way bounded concurrency, the regular-file/size check, fatal UTF-8 decoding,
schema/path/scope validation, normalized content hashes, and complete ancestry
projection. A second byte-length check also rejects growth past the size bound.

Exploratory local probes, not release-gate results:

- For 200 existing fixture files, synchronous stat/read took 448 ms versus 112
  ms with 16 concurrent promise reads. The synchronous experiment was discarded;
  preliminary mixed-build runs were interrupted and are excluded.
- A separate 1,000-file fixture alternated promise and callback reads with the
  same 16-way concurrency and stat checks. The two promise runs took 1,948/2,050
  ms; callback runs took 1,302/563 ms. Ordering and OS caches affect these
  figures. They justify testing the smaller I/O correction, not claiming an
  end-to-end speedup or a one-second recall.

## Remaining work

Full verification remains proportional to revision/file count. Avoiding that
cost safely requires a separately reviewed freshness contract or versioned
source layout with migration/recovery design. A directory timestamp alone cannot
detect an in-place change to a nested revision. File size/mtime alone cannot
detect same-size edits with restored timestamps; the regression suite explicitly
checks this. Do not disable integrity checks to pass a latency gate.

Benchmark a compact, versioned source representation or an explicit verification
policy before selecting another change. Preserve JSONL authority, external Git
imports, deletion visibility, conflict semantics, no-clobber source publication,
and the ability to rebuild after deleting every local cache. No speculative
format migration or local semantic model is implemented here.
