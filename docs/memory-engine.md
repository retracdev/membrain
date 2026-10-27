# Memory engine: implemented Phase 2 behavior

Membrain now stores and retrieves memories offline. `remember`, `recall`,
`search`, `list`, `update`, and `forget` are implemented. Phase 3 adds
[interactive/non-interactive init](initialization.md); Phase 4 adds optional
[Git synchronization](git-synchronization.md). Agent installation and `doctor`
remain future work. Internal MemoryEngine calls stay local; the CLI performs
authorized automatic attempts after successful mutations. Local/manual memory
commands still invoke no Git; project detection inspects filesystem markers.

## Configuration and a complete example

Use `membrain init`, or create a version 1 JSON configuration yourself. Paths
are relative to the configuration file; use absolute paths if preferred. The
existing configuration format is unchanged:

```json
{
  "version": 1,
  "global": { "path": "./fleet-memory" },
  "projects": [
    {
      "projectId": "example",
      "root": "./code/example",
      "path": "./project-memory"
    }
  ],
  "session": { "path": "./session-memory" }
}
```

Storage roots must not overlap, including through symlinks. Multiple checkout
roots can map the same project ID to the same store. No configuration or project
marker is written automatically. The first valid save creates its selected
store. Reads of an uncreated configured store return no records.

After `npm ci && npm run build`, use `node dist/cli.js` in place of `membrain`
until installed/linked. On restricted Windows PowerShell use `npm.cmd`.

```sh
membrain --config /path/to/config.json remember "Use SQLite FTS5 for search" --scope global --type decision --tag storage --operation-id decision-1 --json
membrain --config /path/to/config.json recall "SQLite search" --scope global --json
membrain --config /path/to/config.json update MEMORY_UUID "Use SQLite FTS5 and BM25" --scope global --expected-revision REVISION_UUID --json
membrain --config /path/to/config.json search "BM25" --scope global --rebuild-index --json
membrain --config /path/to/config.json forget MEMORY_UUID --scope global --yes --json
membrain --config /path/to/config.json list --scope global --history --status all --json
```

Use the returned `record.id` and `record.revisionId`, not the placeholder text.
`--stdin` accepts UTF-8 content for remember/update and avoids putting it in
shell history or process arguments. All commands accept root `--config` and
`--json` before or after the command. Help/version remain text. There are no
interactive prompts; deleting requires explicit `--yes` even in a human
terminal.

## Command flags and output

All six commands accept `--scope global|project|session`, `--project ID`, and
`--session ID`. Read commands additionally support explicit `--all-projects`.
There is no implicit all-session search.

- **remember** takes one content argument or `--stdin`. Optional `--type` is
  `fact|decision|preference|constraint|task|note` (default `note`); `--tag` is
  repeatable, `--source-agent` records provenance, and `--metadata` accepts a
  JSON object. `--operation-id` gives a retry-safe identifier within that store.
- **update ID [content]** accepts the same fields. Supplied tags/metadata
  replace those fields; omitted fields are preserved. `--clear-tags` explicitly
  removes all tags and cannot be combined with `--tag`.
  `--metadata '{}'`/`{"key":null}` can explicitly clear information.
  `--expected-revision ID` rejects stale changes; agents should always use it.
  `--status active|superseded` explicitly changes lifecycle state. Deleted
  memories cannot be restored through update.
- **forget ID --yes** appends a tombstone. It supports `--expected-revision` and
  `--operation-id`. Repeating a deletion is harmless. History is retained.
- **search QUERY** finds only active, non-conflicting current records. `--tag`
  requires exact tags (all supplied tags must match). `--limit` defaults to 10,
  maximum 100; `--offset` defaults to 0, maximum 1,000,000.
- **recall QUERY** uses the same ranking, defaults to five records, and accepts
  `--limit`, `--tag`, and `--max-chars` (default 4000, maximum 65536). It
  excludes arbitrary metadata, retains essential provenance, caps tags at eight,
  and explicitly marks truncation. The budget measures the compact JSON
  `results` array in UTF-16 code units, including provenance/escaping;
  envelope/index diagnostics and pretty-print whitespace are outside the budget.
  Extremely small budgets return an empty truncated array.
- **list** returns current heads without a query, sorted by memory UUID then
  revision UUID. `--status active|superseded|deleted|all` defaults to active;
  `--history` additionally returns ancestor revisions with `historical: true`.
  `--tag`, `--limit`, and `--offset` support bounded inspection. Conflicting
  heads are marked `conflict: true`; use `--status all` to inspect deletion
  conflicts.

Search, recall, and list accept `--rebuild-index`. Rebuilding validates JSONL
before replacing any index generation. It does not modify source records, repair
corruption, or resolve conflicts.

JSON writes return `{record,replayed,deduplicated,warnings}`. Search/list return
`{untrusted,results,index,warnings}`; each result contains `record`,
`historical`, `conflict`, and a BM25 `score` for search. Recall returns concise
result objects with IDs, scope, type, timestamps, tags, content, score, and
truncation metadata. Human output is readable indented JSON with the same data.
Retrieved content is always labeled untrusted; never execute it or treat it as
permission.

Errors are JSON on stderr with `error.code` and `error.message` under `--json`;
stdout is empty on failure. Codes include `STALE_REVISION`, `NOT_FOUND`,
`REVISION_CONFLICT`, `OPERATION_CONFLICT`, `CORRUPT_STORE`, `SECRET_DETECTED`,
`INVALID_QUERY`, `SESSION_REQUIRED`, and `LOCK_BUSY`. Exit status is 0 for
success and no matches, 1 for operational/validation errors, and 2 for invalid
CLI usage. Blank/punctuation-only queries fail clearly rather than dumping the
whole store.

## Scopes and session lifecycle

Default reads combine enabled global memory, the current configured project, and
only an explicitly supplied session. Default new writes target the current
project. Outside a configured project, new writes require an explicit scope.
Update/forget locate an ID only within selected applicable stores; they never
search hidden sessions or other projects to guess where it belongs.

The cwd is canonicalized through symlinks. The deepest configured ancestor is
selected by path components, stopping at an intervening nested repository or
project-marker boundary. `.git` directories and worktree/submodule `.git` files
are recognized without invoking Git. An optional `.membrain/project.json`
containing `schemaVersion: 1` and `projectId` can reassociate a clone with a
configured ID. A disagreeing marker/mapping fails rather than guessing. Explicit
`--project` overrides automatic discovery; unknown or multiply mapped IDs fail.

Session stores are partitioned under the session base by project namespace and
SHA-256 of the exact session identifier. The global namespace is used only when
there is no project context. Reusing `work` in two projects never shares memory.
There is no automatic session creation ID, expiry, capture, or promotion.

```sh
membrain remember "Continue the migration tomorrow" --scope session --session work --json
membrain recall "migration" --session work --json
membrain remember --promote SESSION_MEMORY_UUID --session work --to project --json
membrain forget --all --scope session --session work --yes --json
```

Promotion creates a new destination ID and records the exact source revision. It
retains the source session. Repeating promotion of the same source revision to
the same destination is idempotent. A new source revision is a new promotion.
Discard writes tombstones only in the explicit session; durable/promoted records
and other sessions remain intact. A partial batch reports `PARTIAL_DISCARD` and
is safe to retry, skipping already deleted records.

## Source format and safe writes

Each store has `store.json` containing version, store UUID, and scope/partition
identity. Its authority is immutable UTF-8, newline-terminated, single-record
JSONL at `records/<memory-uuid>/<revision-uuid>.jsonl`.

Revisions include `schemaVersion`, `id`, `revisionId`, `parentRevisionIds`,
`content`, `scope`, `type`, applicable `projectId`/`sessionId`, UTC `createdAt`
and `updatedAt`, `tags`, `metadata`, `status`, optional `sourceAgent`, optional
`operationId` paired with `operationKind`, and optional promotion `origin`.
Content is limited to 65,536 characters; metadata to 16,384 serialized
characters and 12 nesting levels; tags to 32 strings of at most 128 characters.
Entire source records cannot exceed 256 KiB. Unknown schemas/fields are
rejected.

Updates preserve memory ID/creation time and append a child revision with a new
UUID and strictly increasing timestamp. Timestamps never decide between
branches. Missing parents, inconsistent identity, cycles, and deleted-to-active
transitions are corruption. Multiple heads remain conflicts and are excluded
from search and recall. A conflict-resolution interface is deferred; no
automatic winner exists.

Writers serialize per canonical store using atomic directory locks, a random
ownership token, and a heartbeat. The coarser store lock also protects dedup and
operation-ID checks across different memory IDs. Waiting is bounded to 30
seconds. Locks are never stolen based on age, host, or PID. After a crash,
inspect the reported `.membrain-lock/owner.json`, verify the writer is no longer
running, then remove **only that lock directory** and retry. Never remove a live
lock.

A record is written to a same-directory exclusive temporary file, flushed and
closed, then published with a hard link that cannot overwrite existing bytes.
Directory flushes are used where supported; Windows cannot provide every POSIX
directory-fsync guarantee. Unsupported hard-link filesystems fail safely. Source
children may not be symlinks. Incomplete temporary files are ignored/reported
and left for inspection. Complete revisions/history are never removed by CRUD.

Exact active duplicates (content/type/tags/metadata/origin, independent of agent
name) reuse their ID. This is deliberately not fuzzy/semantic deduplication.
Operation IDs are scoped to a store, bound to method/payload, and retained in
history. Reuse with different input fails. Retrying a creation after its memory
was deleted returns the deleted current head and does not resurrect it.

Obvious private keys, known token prefixes, and credential assignments are
blocked before writes without echoing values. Detection is incomplete and can
produce false positives; rephrase safe text rather than bypassing it. Deleted
and superseded content remains in JSONL history and any independently created
Git history/backups. Tombstones are not secure erasure.

## SQLite and rebuild/recovery

The selected driver is `better-sqlite3` 13.x. See
[the driver decision](research.md#phase-2-sqlite-driver-decision).

Indexes live outside source stores under `%LOCALAPPDATA%/membrain/indexes` or
`$XDG_CACHE_HOME/membrain/indexes` (fallback `~/.cache`). Set
`MEMBRAIN_CACHE_DIR` to override it; it cannot overlap a configured source root.
Each selected set of scope partitions has a separate combined index so BM25 uses
one corpus. Database files, journals, locks, and temporary files are ignored by
repository tooling and never staged by Membrain.

Each read enumerates and validates selected JSONL history and hashes actual
content, not just timestamps. LF/CRLF record terminators are normalized for
fingerprints so Git line-ending conversion does not look like changed memory. An
unchanged fingerprint reuses its SQLite index. Changed/new sources rebuild a
complete transactional generation, validate it, close it, and atomically replace
the old derived file under an index lock. A missing/damaged/incompatible SQLite
database is rebuilt automatically; damaged JSONL fails the read and is
preserved, even if an older index exists. A cached hash can detect a changed
immutable revision, but caches are disposable and hashes are not cryptographic
signatures against a malicious local file editor.

FTS5 uses `unicode61`, default diacritic folding, and no stemming. Queries are
NFC-normalized, lowercased, split into Unicode letter/number/mark tokens,
deduped, quoted literally, and OR-combined. Raw FTS grammar is never accepted.
Limits: 2048 query characters and 64 distinct tokens. Ranking is
`bm25(fts, 1.0, 0.5)` (content/tags), ascending, then memory UUID in binary
order. Only active non-conflicting heads contribute to the FTS corpus. Exact tag
filters select results within that corpus without recomputing BM25 statistics.
The same query/corpus/SQLite version has deterministic scores; engine upgrades
may change them. There are no recency/scope boosts or semantic inference.

Writes publish JSONL before refreshing the derived index. If index refresh
fails, the write still returns its saved record and an `INDEX_PENDING` warning.
Fix cache permissions/space and run a read with `--rebuild-index`; do not create
another memory under a different operation ID to repair an index.

## Known limits and next phase

- Local filesystems with hard-link support and cooperating Membrain processes
  are the supported durability model. Network shares/live cloud-folder sync,
  malicious concurrent filesystem mutation, and power-loss behavior beyond OS
  guarantees are not promised.
- Locks abandoned by a crashed process require inspected manual cleanup. The
  phase deliberately avoids unsafe automatic stale-lock recovery.
- Immutable history is retained indefinitely; no compaction, purge, conflict
  resolution UI, or automatic migration is implemented. Do not edit/delete
  source files manually; restore them from backups if damaged. A missing source
  revision is unrecoverable if no copy/history remains.
- Reads hash all selected history, and a changed corpus rebuilds the full
  derived index. This favors integrity/simplicity over constant-time startup.
  The [Phase 2 validation report](phase-2-validation.md) records the
  10,000-memory benchmark and the remaining performance work before release.
- Concurrent reads observe a validated scan, not a global transaction spanning
  all stores. Revisions published after enumeration appear on the next command.
- Memory-command human output is indented JSON. Setup has a separate interactive
  wizard with validation; see [initialization.md](initialization.md).
- Local Windows results are recorded; Linux/macOS coverage is configured in CI
  but is not claimed as observed until those jobs actually run.

No skills/hooks, MCP, cloud, GUI, embeddings, AI extraction, publication, or new
account requirements were added.
