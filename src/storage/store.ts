import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { readFile as readFileCallback } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { hostname } from 'node:os';
import { span } from '../profile.js';
import {
  fail,
  isObject,
  projectHeads,
  validateRevision,
  uuid,
} from '../engine/model.js';
import type { Entry, Revision, Warning } from '../engine/model.js';
import type { Location } from '../engine/scopes.js';
import {
  errno,
  publish,
  regularFile,
  safeDirectory,
  withLock,
} from './files.js';
import {
  decodeRevision,
  invalidRevision,
  sourceFile,
  temporary,
} from './revision.js';
import type { LoadedRevision, SourceFile } from './revision.js';
import { replayDirectories } from './replay.js';

// One promise around callback readFile avoids FileHandle promise bookkeeping
// for every open/stat/read/close of a small immutable revision. Concurrency and
// source validation remain unchanged.
const readRevisionBytes = promisify(readFileCallback);

export interface Manifest {
  schemaVersion: 1;
  storeId: string;
  scope: string;
  projectId?: string;
  sessionId?: string;
}
export interface Snapshot {
  location: Location;
  records: Revision[];
  entries: Entry[];
  fingerprint: string;
  hashes: { revisionId: string; hash: string }[];
  warnings: Warning[];
  manifest?: Manifest;
  binding?: string;
}
export interface ReplayTiming {
  enumerationMs: number;
  readValidateHashMs: number;
  projectionMs: number;
  strategy?: 'async' | 'workers';
}

/** Advance a fully verified writer snapshot with its own published revision. */
export function withRevision(snapshot: Snapshot, record: Revision): Snapshot {
  return withRevisions(snapshot, [record]);
}

export function withRevisions(
  snapshot: Snapshot,
  additions: Revision[],
): Snapshot {
  const known = new Set(snapshot.records.map((record) => record.revisionId));
  const added = additions.filter((record) => !known.has(record.revisionId));
  if (!added.length) return snapshot;
  const records = [...snapshot.records, ...added].sort((a, b) =>
    a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : a.revisionId < b.revisionId
          ? -1
          : a.revisionId > b.revisionId
            ? 1
            : 0,
  );
  const hashes = new Map(
    snapshot.hashes.map((item) => [item.revisionId, item.hash]),
  );
  for (const record of added)
    hashes.set(
      record.revisionId,
      createHash('sha256')
        .update(`${JSON.stringify(record)}\n`)
        .digest('hex'),
    );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(snapshot.manifest))
    .update(
      records
        .map((item) => `${item.revisionId}:${hashes.get(item.revisionId)}`)
        .join('\n'),
    )
    .digest('hex');
  return {
    ...snapshot,
    records,
    entries: projectHeads(records),
    fingerprint,
    hashes: records.map((item) => ({
      revisionId: item.revisionId,
      hash: hashes.get(item.revisionId)!,
    })),
  };
}
function matches(
  value: { scope: string; projectId?: string; sessionId?: string },
  location: Location,
): boolean {
  return (
    value.scope === location.scope &&
    value.projectId === location.projectId &&
    value.sessionId === location.sessionId
  );
}
async function readManifest(location: Location): Promise<Manifest | undefined> {
  const file = path.join(location.path, 'store.json');
  try {
    await regularFile(file);
    return validateManifest(
      JSON.parse(await readFile(file, 'utf8')) as unknown,
      location,
    );
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      try {
        await lstat(path.join(location.path, 'records'));
      } catch (missing) {
        if (errno(missing) === 'ENOENT') return undefined;
        throw missing;
      }
    }
    fail(
      'CORRUPT_STORE',
      `Invalid or missing store manifest at ${file}. Preserve the source files and restore/inspect the manifest.`,
    );
  }
}

export function validateManifest(value: unknown, location: Location): Manifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'storeId',
          'scope',
          'projectId',
          'sessionId',
        ].includes(key),
    )
  )
    fail('CORRUPT_STORE', 'Unsupported store manifest.');
  uuid(value.storeId, 'storeId');
  const manifest = value as unknown as Manifest;
  if (!matches(manifest, location))
    fail(
      'CORRUPT_STORE',
      'Store identity does not match its configured scope/project/session.',
    );
  return manifest;
}

async function mapLimit<T, R>(
  items: T[],
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(16, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          result[index] = await action(items[index]!);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}
async function inspectSources(location: Location) {
  const manifest = await readManifest(location);
  const warnings: Warning[] = [];
  if (!manifest)
    return {
      manifest,
      binding: undefined,
      warnings,
      directories: [] as string[],
    };
  const rootStat = await lstat(location.path, { bigint: true });
  const binding = `${hostname()}:${process.platform}:${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`;
  const directory = path.join(location.path, 'records');
  const directoryStat = await lstat(directory).catch(() => undefined);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink())
    fail(
      'CORRUPT_STORE',
      `Missing or unsafe records directory at ${directory}.`,
    );
  for (const rootEntry of await readdir(location.path))
    temporary(path.join(location.path, rootEntry), warnings);
  const directories = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => {
      const subdirectory = path.join(directory, entry.name);
      if (temporary(subdirectory, warnings)) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink())
        fail('CORRUPT_STORE', `Unexpected source path at ${subdirectory}.`);
      try {
        uuid(entry.name);
      } catch {
        fail('CORRUPT_STORE', `Invalid memory directory at ${subdirectory}.`);
      }
      return true;
    })
    .map((entry) => entry.name);
  return { manifest, binding, warnings, directories };
}

export function pathsFingerprint(paths: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...paths].sort()))
    .digest('hex');
}

export async function readInventory(location: Location) {
  const finish = span('store.inventory');
  try {
    const inspected = await inspectSources(location);
    const chunk =
      inspected.directories.length >= 1000
        ? await replayDirectories(
            location,
            inspected.directories,
            undefined,
            true,
          )
        : undefined;
    const names =
      chunk?.reused ??
      (
        await mapLimit(inspected.directories, async (id) => {
          const directory = path.join(location.path, 'records', id);
          return (await readdir(directory, { withFileTypes: true })).flatMap(
            (entry) => {
              const source = sourceFile(
                entry,
                directory,
                id,
                inspected.warnings,
              );
              return source ? [`${id}/${source.revisionId}`] : [];
            },
          );
        })
      ).flat();
    if (chunk) inspected.warnings.push(...chunk.warnings);
    return {
      ...inspected,
      pathsHash: pathsFingerprint(names),
      revisions: names.length,
    };
  } finally {
    finish();
  }
}

export async function readStore(
  location: Location,
  timing?: ReplayTiming,
  cached?: Snapshot,
): Promise<Snapshot> {
  const started = performance.now();
  const finishEnumeration = span('store.enumeration');
  const { manifest, binding, warnings, directories } =
    await inspectSources(location);
  if (!manifest)
    return {
      location,
      records: [],
      entries: [],
      fingerprint: 'empty',
      hashes: [],
      warnings,
    };
  // Checkpoints are local to this filesystem object and manifest identity.
  if (
    cached?.binding !== binding ||
    JSON.stringify(cached.manifest) !== JSON.stringify(manifest)
  )
    cached = undefined;
  const known = new Map<string, LoadedRevision>();
  const byDirectory = new Map<string, string[]>();
  if (cached) {
    const hashes = new Map(
      cached.hashes.map((item) => [item.revisionId, item.hash]),
    );
    for (const record of cached.records) {
      const key = `${record.id}/${record.revisionId}`;
      known.set(key, { record, hash: hashes.get(record.revisionId)! });
      const group = byDirectory.get(record.id) ?? [];
      group.push(key);
      byDirectory.set(record.id, group);
    }
  }
  const directory = path.join(location.path, 'records');
  async function enumerate(): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    await mapLimit(directories, async (id) => {
      const subdirectory = path.join(directory, id);
      for (const file of await readdir(subdirectory, { withFileTypes: true })) {
        const source = sourceFile(file, subdirectory, id, warnings);
        if (source) files.push(source);
      }
    });
    return files.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    );
  }
  const threaded = directories.length >= 1000;
  const files = threaded ? [] : await enumerate();
  const enumerated = performance.now();
  finishEnumeration();
  const finishRead = span('store.readValidateHash');
  let loaded: LoadedRevision[];
  const chunk = threaded
    ? await replayDirectories(
        location,
        directories,
        cached ? byDirectory : undefined,
      )
    : undefined;
  if (chunk) {
    loaded = chunk.loaded;
    for (const key of chunk.reused) loaded.push(known.get(key)!);
    loaded.sort((a, b) =>
      a.record.id < b.record.id
        ? -1
        : a.record.id > b.record.id
          ? 1
          : a.record.revisionId < b.record.revisionId
            ? -1
            : a.record.revisionId > b.record.revisionId
              ? 1
              : 0,
    );
    warnings.push(...chunk.warnings);
  } else
    loaded = await mapLimit(
      threaded ? await enumerate() : files,
      async (source) => {
        const previous = known.get(`${source.id}/${source.revisionId}`);
        if (previous) return previous;
        try {
          await regularFile(source.file);
          return decodeRevision(
            await readRevisionBytes(source.file),
            source,
            location,
          );
        } catch {
          invalidRevision(source.file);
        }
      },
    );
  const validated = performance.now();
  finishRead();
  const finishProjection = span('store.projection');
  const records = loaded.map((entry) => entry.record);
  if (cached) {
    const present = new Set(records.map((record) => record.revisionId));
    const retained = new Set(records.map((record) => record.id));
    for (const record of cached.records)
      if (retained.has(record.id) && !present.has(record.revisionId))
        fail(
          'CORRUPT_STORE',
          'A previously indexed revision is missing from a retained memory. Restore its complete history; missing tombstones must never resurrect a memory.',
        );
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(manifest))
    .update(
      loaded
        .map((entry) => `${entry.record.revisionId}:${entry.hash}`)
        .join('\n'),
    )
    .digest('hex');
  const entries = projectHeads(records);
  finishProjection();
  if (timing) {
    timing.enumerationMs = enumerated - started;
    timing.readValidateHashMs = validated - enumerated;
    timing.projectionMs = performance.now() - validated;
    timing.strategy = chunk ? 'workers' : 'async';
  }
  return {
    location,
    records,
    entries,
    fingerprint,
    hashes: loaded.map(({ record, hash }) => ({
      revisionId: record.revisionId,
      hash,
    })),
    warnings,
    manifest,
    binding,
  };
}

export async function writeStore<T>(
  location: Location,
  action: (snapshot: Snapshot, assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  await safeDirectory(location.path);
  return withLock(location.path, async (assertOwned) => {
    if (!(await readManifest(location))) {
      await safeDirectory(path.join(location.path, 'records'));
      const manifest: Manifest = {
        schemaVersion: 1,
        storeId: randomUUID(),
        scope: location.scope,
        ...(location.projectId ? { projectId: location.projectId } : {}),
        ...(location.sessionId ? { sessionId: location.sessionId } : {}),
      };
      await assertOwned();
      await publish(
        path.join(location.path, 'store.json'),
        `${JSON.stringify(manifest)}\n`,
      );
    }
    return action(await readStore(location), assertOwned);
  });
}
export async function appendRevision(
  location: Location,
  record: Revision,
  assertOwned: () => Promise<void>,
): Promise<Warning[]> {
  validateRevision(record);
  const directory = path.join(location.path, 'records', record.id);
  await safeDirectory(directory);
  await assertOwned();
  const filename = path.join(directory, `${record.revisionId}.jsonl`);
  const serialized = `${JSON.stringify(record)}\n`;
  try {
    await publish(filename, serialized);
    return [];
  } catch (error) {
    if (
      (await readFile(filename, 'utf8').catch(() => undefined)) === serialized
    ) {
      return [
        {
          code: 'PUBLICATION_CHECK_REQUIRED',
          message: `Complete revision ${record.revisionId} of memory ${record.id} exists, but publication/flush reported an error. Inspect filesystem durability before relying on crash recovery; reuse the same operation ID when retrying.`,
        },
      ];
    }
    fail(
      'WRITE_FAILED',
      `Could not verify publication of memory ${record.id}, revision ${record.revisionId} at ${directory} (${errno(error) ?? 'filesystem error'}). Inspect the store and reuse the same operation ID when retrying.`,
    );
  }
}
