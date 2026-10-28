import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { readFile as readFileCallback } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
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

interface Manifest {
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
}
export interface ReplayTiming {
  enumerationMs: number;
  readValidateHashMs: number;
  projectionMs: number;
  strategy?: 'async' | 'workers';
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
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
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
export async function readStore(
  location: Location,
  timing?: ReplayTiming,
): Promise<Snapshot> {
  const started = performance.now();
  const finishEnumeration = span('store.enumeration');
  const manifest = await readManifest(location);
  const warnings: Warning[] = [];
  if (!manifest)
    return {
      location,
      records: [],
      entries: [],
      fingerprint: 'empty',
      hashes: [],
      warnings,
    };
  const directory = path.join(location.path, 'records');
  const directoryStat = await lstat(directory).catch(() => undefined);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink())
    fail(
      'CORRUPT_STORE',
      `Missing or unsafe records directory at ${directory}.`,
    );
  for (const rootEntry of await readdir(location.path))
    temporary(path.join(location.path, rootEntry), warnings);
  const directories = (
    await readdir(directory, { withFileTypes: true })
  ).filter((entry) => {
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
  });
  async function enumerate(): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    await mapLimit(directories, async (entry) => {
      const subdirectory = path.join(directory, entry.name);
      for (const file of await readdir(subdirectory, { withFileTypes: true })) {
        const source = sourceFile(file, subdirectory, entry.name, warnings);
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
        directories.map((entry) => entry.name),
      )
    : undefined;
  if (chunk) {
    loaded = chunk.loaded;
    warnings.push(...chunk.warnings);
  } else
    loaded = await mapLimit(
      threaded ? await enumerate() : files,
      async (source) => {
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
