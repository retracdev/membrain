import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { chmod, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  canonical,
  contains,
  safeDirectory,
  withLock,
} from '../storage/files.js';
import type { Snapshot } from '../storage/store.js';
import { fail } from '../engine/model.js';
import type { Revision, State, Warning } from '../engine/model.js';
import { MembrainError } from '../errors.js';

export interface QueryOptions {
  query?: string;
  state?: State | 'all';
  tags?: string[];
  history?: boolean;
  limit: number;
  offset?: number;
  rebuild?: boolean;
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

export function literalQuery(input: string): string {
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
  return tokens.map((token) => `"${token}"`).join(' OR ');
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
  const query =
    options.query === undefined ? undefined : literalQuery(options.query);
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
  await safeDirectory(cacheRoot);
  const directory = path.join(cacheRoot, key);
  await safeDirectory(directory);
  const file = path.join(directory, 'index.sqlite');
  const warnings = snapshots.flatMap((item) => item.warnings);
  return withLock(directory, async () => {
    let db: Database.Database | undefined;
    let rebuild = options.rebuild ?? false;
    try {
      const stat = await lstat(file).catch(() => undefined);
      if (stat?.isSymbolicLink() || (stat && !stat.isFile()))
        fail(
          'UNSAFE_CACHE_PATH',
          `Index path is not a regular file at ${file}.`,
        );
      if (stat) {
        try {
          db = new Database(file, { timeout: 5_000 });
          if (db.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('integrity check');
          db.prepare("INSERT INTO fts(fts) VALUES ('integrity-check')").run();
          const settings = new Map(
            db
              .prepare<[], { key: string; value: string }>(
                'SELECT key,value FROM settings',
              )
              .all()
              .map((item) => [item.key, item.value]),
          );
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
          rebuild ||=
            settings.get('version') !== schemaVersion ||
            settings.get('fingerprint') !== fingerprint;
        } catch (error) {
          db?.close();
          db = undefined;
          if (error instanceof MembrainError) throw error;
          rebuild = true;
          warnings.push({
            code: 'INDEX_RECOVERED',
            message:
              'The disposable SQLite index was damaged or incompatible and has been rebuilt from validated JSONL.',
          });
        }
      } else rebuild = true;
      if (rebuild) {
        db?.close();
        db = undefined;
        const temporary = path.join(directory, `${randomUUID()}.sqlite`);
        let generation: Database.Database | undefined;
        try {
          generation = new Database(temporary);
          await chmod(temporary, 0o600);
          populate(generation, snapshotsSorted, fingerprint);
          if (generation.pragma('integrity_check', { simple: true }) !== 'ok')
            fail('INDEX_FAILED', 'New index generation failed validation.');
          generation.close();
          generation = undefined;
          await rename(temporary, file);
        } finally {
          generation?.close();
          await unlink(temporary).catch(() => undefined);
        }
        db = new Database(file, { timeout: 5_000 });
      }
      if (!db) fail('INDEX_FAILED', 'Could not open the local search index.');
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
          : `SELECT e.revisionId,e.head,e.conflict,bm25(fts,1.0,0.5) AS score FROM fts JOIN entries e ON e.revisionId=fts.revisionId WHERE ${clauses.join(' AND ')} ORDER BY score ASC,e.id COLLATE BINARY LIMIT ? OFFSET ?`;
      bindings.push(options.limit, offset);
      const source = new Map(
        snapshots
          .flatMap((item) => item.records)
          .map((record) => [record.revisionId, record]),
      );
      const rows = db
        .prepare<
          (string | number)[],
          { revisionId: string; head: number; conflict: number; score?: number }
        >(sql)
        .all(...bindings);
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
        index: { path: file, rebuilt: rebuild, revisions: source.size },
        warnings,
      };
    } finally {
      db?.close();
    }
  });
}
