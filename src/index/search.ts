import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { chmod, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonical,
  contains,
  safeDirectory,
  withLock,
  errno,
} from '../storage/files.js';
import type { Snapshot } from '../storage/store.js';
import { fail } from '../engine/model.js';
import type { Revision, State, Warning } from '../engine/model.js';
import { MembrainError } from '../errors.js';
import { span } from '../profile.js';

export interface QueryOptions {
  query?: string;
  state?: State | 'all';
  tags?: string[];
  history?: boolean;
  limit: number;
  offset?: number;
  rebuild?: boolean;
  readOnly?: boolean;
  literal?: boolean;
}
export interface Hit {
  record: Revision;
  conflict: boolean;
  historical: boolean;
  score?: number;
}
export interface QueryResult {
  results: Hit[];
  index: { path: string; rebuilt: boolean; revisions: number };
  warnings: Warning[];
}

const stopwords = new Set(
  'a an the i me my we our you your he she it its they their this that these those am is are was were be been being do does did have has had can could would should will shall may might must of for to from in on at by with as and or but if then than which what who whom whose how when where why'.split(
    ' ',
  ),
);

export function literalQuery(input: string, literal = false): string {
  if (input.length > 2_048)
    fail('INVALID_QUERY', 'Query exceeds 2,048 characters.');
  const tokens = [
    ...new Set(
      input
        .normalize('NFC')
        .toLowerCase()
        .match(/[\p{L}\p{N}\p{M}]+/gu) ?? [],
    ),
  ];
  if (!tokens.length)
    fail(
      'INVALID_QUERY',
      'Enter a query containing at least one word or number.',
    );
  if (tokens.length > 64)
    fail('INVALID_QUERY', 'Query exceeds 64 distinct tokens.');
  const meaningful = literal
    ? tokens
    : tokens.filter((token) => !stopwords.has(token));
  // A query consisting only of function words can still name a code identifier.
  return (meaningful.length ? meaningful : tokens)
    .map((token) => `"${token}"`)
    .join(' OR ');
}
export function defaultCacheRoot(): string {
  return path.resolve(
    process.env.MEMBRAIN_CACHE_DIR ||
      path.join(
        process.platform === 'win32'
          ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
          : process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'),
        'membrain',
        'indexes',
      ),
  );
}
const schemaVersion = '1';

function populate(
  db: Database.Database,
  snapshots: Snapshot[],
  fingerprint: string,
): void {
  db.exec(`PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hashes(key TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE entries(revisionId TEXT PRIMARY KEY, id TEXT NOT NULL, status TEXT NOT NULL, head INTEGER NOT NULL, conflict INTEGER NOT NULL, tags TEXT NOT NULL);
    CREATE VIRTUAL TABLE fts USING fts5(content, tags, revisionId UNINDEXED, tokenize='unicode61');`);
  const settings = db.prepare('INSERT INTO settings VALUES (?, ?)');
  const hash = db.prepare('INSERT INTO hashes VALUES (?, ?)');
  const entry = db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)');
  const fts = db.prepare(
    'INSERT INTO fts(content, tags, revisionId) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    settings.run('version', schemaVersion);
    settings.run('fingerprint', fingerprint);
    for (const snapshot of snapshots) {
      for (const item of snapshot.hashes)
        hash.run(`${snapshot.location.path}:${item.revisionId}`, item.hash);
      const heads = new Map(
        snapshot.entries.map((item) => [item.record.revisionId, item]),
      );
      for (const record of snapshot.records) {
        const head = heads.get(record.revisionId);
        entry.run(
          record.revisionId,
          record.id,
          record.status,
          head ? 1 : 0,
          head?.conflict ? 1 : 0,
          JSON.stringify(record.tags),
        );
        if (head && !head.conflict && record.status === 'active')
          fts.run(record.content, record.tags.join(' '), record.revisionId);
      }
    }
  })();
}

export async function queryIndex(
  snapshots: Snapshot[],
  options: QueryOptions,
  protectedRoots: string[],
  cacheRoot = defaultCacheRoot(),
): Promise<QueryResult> {
  const finishIndex = span('index.total');
  const query =
    options.query === undefined
      ? undefined
      : literalQuery(options.query, options.literal);
  if (options.readOnly && options.rebuild)
    fail(
      'INVALID_QUERY',
      '--read-only cannot be combined with --rebuild-index.',
    );
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    fail('INVALID_LIMIT', 'Limit must be an integer from 1 through 100.');
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    fail('INVALID_LIMIT', 'Offset must be an integer from 0 through 1000000.');
  cacheRoot = await canonical(cacheRoot);
  for (const root of protectedRoots) {
    const source = await canonical(root);
    if (contains(source, cacheRoot) || contains(cacheRoot, source))
      fail(
        'UNSAFE_CACHE_PATH',
        'Cache and memory storage directories must not overlap. Set MEMBRAIN_CACHE_DIR to a separate local directory.',
      );
  }
  const snapshotsSorted = [...snapshots].sort((a, b) =>
    a.location.path < b.location.path ? -1 : 1,
  );
  const key = createHash('sha256')
    .update(JSON.stringify(snapshotsSorted.map((item) => item.location)))
    .digest('hex');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(snapshotsSorted.map((item) => item.fingerprint)))
    .digest('hex');
  const directory = path.join(cacheRoot, key);
  const file = path.join(directory, 'index.sqlite');
  const warnings = snapshots.flatMap((item) => item.warnings);
  let damaged = false;
  const source = new Map(
    snapshots
      .flatMap((item) => item.records)
      .map((record) => [record.revisionId, record]),
  );
  // Ordinary queries open SQLite read-only and do not acquire a filesystem lock.
  // Replacement is serialized only when maintenance is actually necessary.
  async function existing(rebuilt = false): Promise<QueryResult | undefined> {
    let db: Database.Database | undefined;
    try {
      const parent = await lstat(directory).catch((error: unknown) => {
        if (errno(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!parent) return undefined;
      if (!parent.isDirectory() || parent.isSymbolicLink())
        fail(
          'UNSAFE_CACHE_PATH',
          `Index directory is not a real directory at ${directory}.`,
        );
      const stat = await lstat(file).catch((error: unknown) => {
        if (errno(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (stat?.isSymbolicLink() || (stat && !stat.isFile()))
        fail(
          'UNSAFE_CACHE_PATH',
          `Index path is not a regular file at ${file}.`,
        );
      if (!stat) return undefined;
      const finishOpen = span('index.open');
      db = new Database(file, {
        readonly: true,
        fileMustExist: true,
        timeout: 5_000,
      });
      db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY;',
      );
      finishOpen();
      const finishIntegrity = span('index.integrity');
      // SQLite >=3.44 checks FTS5 through xIntegrity as part of this read-only
      // pragma. It replaces the old quick_check + write-classified FTS INSERT.
      if (db.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new Error('integrity check');
      finishIntegrity();
      const finishFreshness = span('index.freshness');
      const settings = new Map(
        db
          .prepare<[], { key: string; value: string }>(
            'SELECT key,value FROM settings',
          )
          .all()
          .map((item) => [item.key, item.value]),
      );
      const current =
        settings.get('version') === schemaVersion &&
        settings.get('fingerprint') === fingerprint;
      // This freshly computed fingerprint covers every source hash and manifest.
      // Only changed sources need the per-revision comparison, which rejects
      // edits to immutable IDs before considering a replacement generation.
      if (current) {
        // Retain structural recovery without materializing every hash row.
        db.prepare('SELECT key,hash FROM hashes LIMIT 0').all();
      } else {
        const oldHashes = new Map(
          db
            .prepare<[], { key: string; hash: string }>(
              'SELECT key,hash FROM hashes',
            )
            .all()
            .map((item) => [item.key, item.hash]),
        );
        for (const snapshot of snapshots)
          for (const item of snapshot.hashes) {
            const old = oldHashes.get(
              `${snapshot.location.path}:${item.revisionId}`,
            );
            if (old && old !== item.hash)
              fail(
                'CORRUPT_STORE',
                'An immutable source revision changed since it was indexed. Restore the original or inspect its provenance; do not edit revision files in place.',
              );
          }
      }
      finishFreshness();
      if ((!rebuilt && options.rebuild) || !current) return undefined;
      const finishQuery = span('index.ftsBm25');
      const clauses: string[] = [];
      const bindings: (string | number)[] = [];
      if (query !== undefined) {
        clauses.push('fts MATCH ?');
        bindings.push(query);
      } else {
        if (!options.history) clauses.push('e.head = 1');
        if (options.state !== 'all') {
          clauses.push('e.status = ?');
          bindings.push(options.state ?? 'active');
        }
      }
      for (const tag of options.tags ?? []) {
        clauses.push(
          'EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)',
        );
        bindings.push(tag);
      }
      const sql =
        query === undefined
          ? `SELECT e.revisionId,e.head,e.conflict FROM entries e ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY e.id COLLATE BINARY, e.revisionId COLLATE BINARY LIMIT ? OFFSET ?`
          : `SELECT e.revisionId,e.head,e.conflict,bm25(fts,1.0,2.0) AS score FROM fts JOIN entries e ON e.revisionId=fts.revisionId WHERE ${clauses.join(' AND ')} ORDER BY score ASC,e.id COLLATE BINARY LIMIT ? OFFSET ?`;
      bindings.push(options.limit, offset);
      const rows = db
        .prepare<
          (string | number)[],
          { revisionId: string; head: number; conflict: number; score?: number }
        >(sql)
        .all(...bindings);
      finishQuery();
      const results = rows.map((row) => {
        const record = source.get(row.revisionId);
        if (!record)
          fail(
            'INDEX_FAILED',
            'Index contains an unknown source revision. Rebuild it with --rebuild-index.',
          );
        return {
          record,
          conflict: row.conflict === 1,
          historical: row.head !== 1,
          ...(row.score === undefined ? {} : { score: row.score }),
        };
      });
      return {
        results,
        index: { path: file, rebuilt, revisions: source.size },
        warnings,
      };
    } catch (error) {
      if (error instanceof MembrainError || errno(error)?.startsWith('E'))
        throw error;
      damaged = true;
      return undefined;
    } finally {
      db?.close();
    }
  }
  try {
    const cached = await existing();
    if (cached) return cached;
    if (options.readOnly)
      fail(
        'INDEX_READ_ONLY',
        'Read-only retrieval needs a current, readable SQLite index for these scopes. Allow internal cache maintenance and retry without --read-only, or choose an existing cache with MEMBRAIN_CACHE_DIR. Memory source records are never changed by retrieval.',
      );
    await safeDirectory(cacheRoot);
    await safeDirectory(directory);
    return await withLock(directory, async (assertOwned) => {
      const cached = await existing();
      if (cached) return cached;
      const temporary = path.join(directory, `${randomUUID()}.sqlite`);
      let generation: Database.Database | undefined;
      try {
        generation = new Database(temporary);
        await chmod(temporary, 0o600);
        const finishBuild = span('index.build');
        populate(generation, snapshotsSorted, fingerprint);
        finishBuild();
        if (generation.pragma('integrity_check', { simple: true }) !== 'ok')
          fail('INDEX_FAILED', 'New index generation failed validation.');
        generation
          .prepare("INSERT INTO fts(fts) VALUES ('integrity-check')")
          .run();
        generation.close();
        generation = undefined;
        // Windows cannot replace a SQLite file while another reader holds its
        // native handle. Wait briefly for readers, retaining the maintenance
        // lock and checking ownership on every attempt. Never unlink the old
        // generation or relax permissions to force replacement.
        for (let attempt = 0; ; attempt++) {
          await assertOwned();
          try {
            await rename(temporary, file);
            break;
          } catch (error) {
            if (
              process.platform !== 'win32' ||
              attempt >= 40 ||
              !['EPERM', 'EACCES', 'EBUSY'].includes(errno(error) ?? '')
            )
              throw error;
            await delay(25);
          }
        }
      } finally {
        generation?.close();
        await unlink(temporary).catch(() => undefined);
      }
      if (damaged)
        warnings.push({
          code: 'INDEX_RECOVERED',
          message:
            'The disposable SQLite index was damaged or incompatible and has been rebuilt from validated JSONL.',
        });
      const result = await existing(true);
      if (!result)
        fail(
          'INDEX_FAILED',
          'Cannot read the rebuilt SQLite index. Check the SQLite installation and retry with --rebuild-index.',
        );
      return result;
    });
  } catch (error) {
    if (error instanceof MembrainError) throw error;
    fail(
      'INDEX_UNAVAILABLE',
      `Cannot access the local index at ${directory}. Close commands holding the index and check cache directory permissions, free space, and SQLite installation, or set MEMBRAIN_CACHE_DIR to a writable local directory. A current index can be reused with --read-only; a missing or stale index needs internal cache writes. Memory source records were not changed.`,
    );
  } finally {
    finishIndex();
  }
}
