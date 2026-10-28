# Index freshness and consistency

JSONL revisions remain authoritative. SQLite is a local, disposable projection,
not evidence that source files are unchanged. There is no persistent process,
filesystem watcher, source metadata cache, or background refresh.

## Verification on every read

1. Resolve canonical selected stores and validate the manifest identity against
   the requested global/project/session partition.
2. Enumerate the actual memory directories and revision files. Reject unexpected
   paths and symbolic links; report unpublished temporary files.
3. Check each revision's regular-file type and size, read its bytes, reject
   malformed UTF-8/incomplete JSONL, validate its schema/path/scope identity,
   and hash its content. Normalize a final CRLF to LF for Git checkout
   compatibility.
4. Validate complete revision ancestry and derive current heads/conflicts.
   Reject duplicate memory/revision identities across selected stores.
5. Compare the selected, freshly computed content fingerprint with the index. An
   exact match covers all source hashes and manifest identities, so no second
   full read of SQLite's hash table is necessary. A zero-row schema query still
   detects a missing provenance table/columns and triggers cache recovery. When
   the fingerprint differs, compare previously indexed revision hashes before
   rebuilding. A modified immutable revision is an error, even if its size and
   modification time match. Missing files and new revisions change the
   fingerprint; missing ancestry is corruption, not an incomplete rebuild.
6. Verify SQLite integrity, including FTS, and execute the lexical/BM25 query.
   Reuse current generations read-only without a maintenance lock or cache
   writes. Missing, stale, or damaged generations require a validated rebuild;
   `--read-only` refuses maintenance.

Rebuilds retain the existing lock, complete temporary generation, integrity
checks, and atomic generation replacement. A failing rebuild does not publish a
partial index. Windows replacement waits a bounded period for native readers and
never unlinks a held generation or relaxes permissions. Recall does not modify
source bytes or revision history; the OS may update access times.

## Invalidation across processes and machines

Every process repeats verification; there is no time-to-live or grace period.
Creation, updates, tombstones, supersession, promotion, and session discard are
visible to a query started after publication completes. Git checkout/fetch/merge
imports and independent external file changes go through the same enumeration
and content checks, without relying on Git metadata or calling Git during
recall. Physical source removal cannot leave a successful cached search hit.

Index keys include canonical store locations and scope identities. A different
project/session selection uses its own corpus and BM25 ranking. Index caches are
not portable and are never synchronized; another computer verifies its own
sources and rebuilds locally. Removing all caches preserves replay and ranking.
Without an earlier trusted hash, a structurally valid source is authoritative;
an absent index cannot establish whether that source was edited in the past.

## Concurrency and limitations

Writers serialize immutable publication under store locks. Readers do not take
store locks and do not promise an atomic snapshot across stores or across a
concurrent external checkout. An overlapping publication may appear in this read
or the next; an incomplete/inconsistent source scan fails validation rather than
returning an incomplete rebuild. A query started after a completed write/sync
must observe its revisions. External tools must not modify source files in place
while readers are active. This is the existing consistency contract, not a
serializable multi-store transaction.

Directory mtimes cannot detect edits to nested files. File size/mtime also miss
same-size timestamp-restored edits. Ctime, inode identity, and local change
journals have platform/filesystem limits and cannot provide this portable
content-verification contract alone. Permission failures and uncertain freshness
must fail or trigger full validation, never authorize stale-cache fallback.
Network shares and live cloud-folder synchronization retain their existing
unsupported locking/durability limitations.

Full verification therefore remains proportional to source file/history count.
See [performance.md](performance.md) and the Phase 7 measurements for the cost;
the one-second release gate cannot be closed using an SQL-only measurement.

## Temporary replay workers

Stores with at least 1,000 memory directories use synchronous, checked
filesystem reads in temporary Node worker threads. A process-wide limit of eight
applies even when several stores replay concurrently. Workers read only the
explicitly selected partition and use the same JSONL decoder/schema/hash
validation as the ordinary path. The main thread sorts revisions
deterministically and checks the complete graph and cross-store identities
before querying the index.

All workers exit before replay returns or releases a writer's store lock,
including on failure. No idle worker survives. Small stores retain bounded
asynchronous reads. If worker startup/resources/permissions are unavailable, all
workers drain and the ordinary path performs a complete fresh scan; no partial
worker output or stale index is trusted. Source corruption remains an error. The
fallback does not change filesystem permissions or require `--allow-worker` from
a read-only caller. Additional transient RAM is a measured tradeoff; fewer
source files or weaker validation are not part of this change.
