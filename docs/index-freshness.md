# Index freshness and consistency

JSONL revisions remain authoritative. SQLite is a local, disposable projection.
Phase 8 adds explicit `--verification fast`; **strict remains the default**,
including existing callers and the portable skill. No daemon, watcher,
expiration window, background refresh, or cooperative source journal exists.

## Choosing verification

```sh
membrain recall "SQLite decisions" --verification fast
membrain recall "SQLite decisions" --verification strict
```

The option also applies to `search` and `list`. JSON `index.verification`
records the effective mode. `--rebuild-index` always verifies all source bytes,
even in fast mode. Configuration and JSONL remain schema 1; disposable SQLite is
schema 2.

Strict preserves every-read byte verification. Fast is an explicit choice for
immutable revision workflows: it detects actual new/removed paths each
invocation and verifies bytes of every returned revision. It **cannot prove
unreturned, previously indexed bytes are unchanged**. In-place edits to
unreturned revisions can affect graph/search freshness until strict verification
or rebuild. There is no time-based bound. Run strict after editing existing
files or when auditing provenance. Fast results are not a complete authoritative
integrity audit.

## Fast path and incremental maintenance

1. Resolve canonical selected stores and validate manifests. Checkpoints bind
   scope/path/store identity to hostname/platform and root device/inode/birth
   time. Changed bindings/manifests force full verification; caches are local.
2. Read a compatible checkpoint in a SQLite read transaction, check database/FTS
   integrity, aggregate hash-inventory completeness and a digest of cached
   record JSON. Missing, damaged or incompatible checkpoints require full
   replay. Store validated revision JSON, hashes and manifest identities in the
   disposable database.
3. Enumerate actual memory directories and revision filenames every invocation.
   Reject unexpected paths/symlinks and report unpublished files. No timestamp
   or size is freshness evidence: restored directory times cannot hide new
   updates/tombstones. Work remains proportional to directories/revision names,
   but historical files need no open/read/hash. Large stores use the existing
   bounded temporary workers, with ordinary bounded traversal if workers are
   unavailable.
4. Read/decode/validate/hash additions. Reuse validated history only for paths
   still present. Validate the resulting complete graph and cross-store IDs. If
   an indexed revision disappears while its memory retains other revisions, fail
   rather than expose an earlier head. Entire removed memories leave the corpus.
   Without a prior cache, past removals/edits cannot be reconstructed.
5. Copy compatible SQLite into a private generation under the maintenance lock.
   Transactionally update hash rows and only affected memory/FTS projections;
   commit fingerprint/checkpoint together. Check SQLite/FTS integrity, close and
   atomically replace the generation, retaining bounded Windows sharing retries.
   JSON `index.updated` denotes incremental maintenance; `index.rebuilt` denotes
   a complete rebuild.
6. Query FTS/BM25 in a consistent read transaction. Reread actual JSONL for
   every hit, validate it and compare normalized hashes, then return the freshly
   decoded record. Altered/unreadable hit bytes fail retrieval. This cannot find
   an unreturned in-place edit that makes a previously irrelevant record newly
   relevant: use strict for that guarantee.

Git pulls, additive merges, revision-adding conflict resolution, independent
agents and older clients change the inventory directly. No Git HEAD shortcut or
Git executable is needed during recall. In-place edits during conflict
resolution require strict verification. Malformed new files, incomplete JSONL,
unresolved semantic heads and unexpected paths are never silently accepted. Sync
retains complete replay, secret scans, exact-path allowlists, policy
authorization and hook/filter refusal. No sync source layout or safety rule
changes.

Writes still verify all source history under their store lock before publishing
immutable JSONL. Post-save projection advances that verified writer snapshot
with the published revision, avoiding a second history replay while retaining
prior hash comparisons. It uses incremental maintenance; failure retains the
durable save with INDEX_PENDING. Queries begun after publication observe new
paths; overlapping writes can appear on this read or the next. An index
advancing ahead of a scan can trigger bounded rescans; sustained change fails
safely. There is no atomic transaction across stores/external checkouts.

## Recovery and permissions

Missing, incompatible/corrupted indexes and explicit rebuilds require complete
authoritative replay. No partial replay is published. Updates use private
copies: a crash leaves the old or new complete published generation, never a hot
journal beside the published index. Unpublished cache generations are never
selected by discovery and may be removed with the cache. Killed lock owners
require existing manual owner-inspection recovery; locks are never stolen.
Source temporaries remain intact.

Unchanged queries reuse caches read-only without cache locks/writes.
`--read-only` refuses maintenance. Permission errors never authorize stale
fallback or bypass. Fast verifies directory traversal and returned-file access
rather than opening every unreturned historical file. POSIX modes and Windows
ACL fixtures cover available permission behavior. Network/cloud-folder locking
limits remain.

Immediate detection of arbitrary same-name historical byte edits requires
reading the bytes on portable filesystems. Timestamps, watcher events, Git
checkpoints and cooperative journals cannot prove their absence. Compact sources
could reduce file count but require migration and merge design. Explicit fast
mode avoids that complexity without silently changing existing callers'
guarantees. Performance claims must identify the mode; strict is the
compatibility default.

## Strict verification on every read

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

## Strict invalidation across processes and machines

Every strict process repeats verification; there is no time-to-live or grace
period. Creation, updates, tombstones, supersession, promotion, and session
discard are visible to a query started after publication completes. Git
checkout/fetch/merge imports and independent external file changes go through
the same enumeration and content checks, without relying on Git metadata or
calling Git during recall. Physical source removal cannot leave a successful
cached search hit.

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
