# Phase 2 validation and remaining gates

Observed locally on Windows x64, Node 24.19.0, npm 11.17.0. The existing GitHub
Actions configuration runs Node 24 on Windows, Linux, and macOS. Remote CI was
not run because no commit/push/PR was authorized; the other two platforms are
configured coverage, not observed passes.

## Functional and reliability evidence

Final local verification: **36 tests passed**, with formatting, linting, strict
type checking, and builds all passing through `npm run check`. A clean `npm ci`,
package allowlist checks, and native FTS5/BM25 loading after reinstall also
passed. The isolated CLI demonstration returned the same saved/recalled memory
ID, confirmed session isolation, rebuilt its index, and retained three revisions
after deletion with zero current matches. Root README/LICENSE hashes and Git
HEAD match the start of this phase; no commit, push, PR, or publication was
performed.

The suite also verifies that Git-style LF/CRLF conversion preserves portable
source identity and cached fingerprints.

The automated suite exercises:

- CRUD identity, timestamps, tags, metadata, source agents, explicit
  supersession, expected-revision checks, retained tombstones/history, and no
  resurrection by retrying an old operation ID.
- Global/project/session isolation, custom directories, nested cwd, explicit
  projects, repository boundaries, project markers, path-prefix lookalikes,
  overlapping roots, source symlinks, and explicit session promotion/discard.
- FTS5/BM25 relevance, literal grammar escaping, Unicode/diacritics, exact tags,
  deterministic ties, limits/pagination, no matches, invalid queries, and
  bounded recall context.
- Rebuilding from JSONL after missing/damaged SQLite files, corrupt source
  preservation, missing/wrong manifests, invalid UTF-8/incomplete JSONL,
  competing heads, and index failure after a successful durable save.
- Twenty concurrent independent writer processes (all records preserved), twenty
  competing guarded updates (one accepted), and twenty retries sharing an
  operation ID (one memory/revision). All run without a Git executable on PATH.
- Killing a writer after temporary-file flush and after complete publication.
  Replay accepts complete revisions only, reports unpublished temporary files,
  and refuses to steal abandoned locks. The test verifies the process exited
  before cleaning only its isolated lock and retrying.
- Noninteractive CLI flags/stdin, JSON stdout/stderr, explicit deletion consent,
  secret-pattern rejection without echoing input, source immutability, and
  unchanged unrelated repository files/HEAD/index fixtures under manual and
  automatic configuration policies.

Run `npm run check` for ownership, formatting, linting, strict type checking,
builds, and the complete automated suite. `npm run pack:check` checks packaging
without publication. Native installation and the production SQLite FTS5/BM25
probe pass with better-sqlite3 13.0.3.

`npm run demo` is a repeatable isolated CLI demonstration. It saves a project
decision from a nested cwd, recalls the same ID, updates it with its expected
revision, demonstrates hidden/explicit session retrieval, rebuilds the index,
deletes the decision, and verifies zero current matches plus three retained
revisions. It runs with an empty PATH and removes its own temporary fixture.

## Scale measurement

`npm run benchmark` prepares **10,000 active memories with 20,000 JSONL
revisions**, then measures full replay, cold/warm search, an indexed save, and a
separate-process bounded CLI recall. Preparation/cleanup are excluded. Fixtures
are synthetic temporary data; no developer memory is read or retained.

The initial Windows run with sequential directory enumeration measured replay
33,932 ms, cold search 19,561 ms, warm search 33,382 ms, indexed save 44,302 ms,
and CLI recall 20,146 ms. These are full-operation measurements, not isolated
SQLite query times; OS file caches affect ordering.

After bounded parallel directory enumeration, the measured run was:

- Source replay/validation: **25,982 ms**.
- Cold search including source verification and index generation: **17,942 ms**.
- Warm search including full source verification: **18,955 ms**.
- Save including durable source publication and index refresh: **37,711 ms**.
- Separate-process CLI recall: **21,636 ms**; five results, **1,613** serialized
  result characters, within the default 4,000-character budget.

The file-count layout preserves the conflict/durability model, but full hashing
and filesystem traversal dominate at this scale on this machine. These results
are a known performance limitation, not a claim of fast large-store retrieval.
Do not hide it behind a microbenchmark of SQLite alone or silently skip source
validation. A separate 1,000-file I/O probe measured approximately 1,256 ms for
bounded asynchronous reads and 996 ms for synchronous reads; switching APIs
alone would not remove the architectural scan cost.

For repeat measurements on this development environment, use investigation
thresholds of 40 s for full replay, 35 s for search/CLI recall, and 60 s for an
indexed save at this fixture size. These generous thresholds detect regressions
on this machine; they are **not release latency targets or CI timing
assertions**. Before v1 release, measure representative macOS/Linux systems and
establish a much faster freshness-check strategy or a versioned compact
export/layout based on evidence. Preserve authoritative JSONL, rebuildability,
external-change handling, and conflict semantics in that work. Phase 3 setup
work can proceed with this limitation explicitly tracked.

## Limits preserved for review

Abandoned locks require inspected manual recovery. Local hard-link-capable
filesystems are supported; network shares and live folder sync are not a tested
concurrency model. History has no garbage collection. Cached digests can detect
known immutable-file changes but are not signatures or backups. Explicit
conflict resolution and secure erasure are not implemented. Missing/deleted
source data cannot be recreated from nothing; retain backups or user-managed
history.

The root README and MIT license are checked against the starting checkout. There
are no production Git subprocesses, commits, pushes, package publications, agent
integrations, provider calls, MCP dependencies, or hosted components.
