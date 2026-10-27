import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  fail,
  isObject,
  projectHeads,
  scanSecrets,
  uuid,
  validateRevision,
} from '../engine/model.js';
import type { Revision } from '../engine/model.js';
import type { Location } from '../engine/scopes.js';
import { readStore } from '../storage/store.js';
import { contains, regularFile } from '../storage/files.js';
import type { Git } from './git.js';

export interface Owner {
  location: Location;
  prefix: string;
}
export interface Managed {
  owner?: Owner;
  markerId?: string;
  kind: 'manifest' | 'revision' | 'marker';
}
export interface Source {
  bytes: Buffer;
  record?: Revision;
}
const id =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const revisionPath = new RegExp(`^records/(${id})/(${id})\\.jsonl$`, 'u');
export function relative(root: string, file: string): string {
  if (!contains(root, file))
    fail('UNSAFE_SYNC_PATH', 'A selected path escapes its Git repository.');
  return path.relative(root, file).split(path.sep).join('/');
}
export function managed(
  file: string,
  owners: Owner[],
  markers: Map<string, string>,
): Managed | undefined {
  const markerId = markers.get(file);
  if (markerId) return { kind: 'marker', markerId };
  for (const owner of owners) {
    const local = owner.prefix
      ? file.startsWith(`${owner.prefix}/`)
        ? file.slice(owner.prefix.length + 1)
        : undefined
      : file;
    if (local === 'store.json') return { kind: 'manifest', owner };
    if (local && revisionPath.test(local)) return { kind: 'revision', owner };
  }
  return undefined;
}
export function normalized(bytes: Buffer): string {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return content.replace(/\r\n/gu, '\n');
}
export function decode(
  file: string,
  bytes: Buffer,
  description: Managed,
): Source {
  if (bytes.length > 262144)
    fail(
      'INVALID_SYNC_SOURCE',
      'A managed source file exceeds the memory format size limit.',
    );
  let value: unknown;
  let content: string;
  try {
    content = normalized(bytes);
    value = JSON.parse(content);
  } catch {
    fail(
      'INVALID_SYNC_SOURCE',
      'A Git/local memory file is not valid UTF-8 JSON. Preserve both copies and inspect source integrity.',
    );
  }
  scanSecrets(value);
  const location = description.owner?.location;
  if (description.kind === 'revision') {
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n'))
      fail(
        'INVALID_SYNC_SOURCE',
        'A revision must be one complete newline-terminated JSONL record.',
      );
    const record = validateRevision(value);
    const parts = file.split('/');
    if (
      record.id !== parts.at(-2) ||
      `${record.revisionId}.jsonl` !== parts.at(-1) ||
      record.scope !== location!.scope ||
      record.projectId !== location!.projectId ||
      record.sessionId !== location!.sessionId
    )
      fail(
        'SYNC_IDENTITY_CONFLICT',
        'Revision path and configured scope/project/session identity disagree.',
      );
    return { bytes, record };
  }
  if (!isObject(value) || value.schemaVersion !== 1)
    fail(
      'INVALID_SYNC_SOURCE',
      'Unsupported managed manifest or project marker.',
    );
  if (description.kind === 'marker') {
    if (
      value.projectId !== description.markerId ||
      Object.keys(value).some(
        (key) => !['schemaVersion', 'projectId'].includes(key),
      )
    )
      fail(
        'SYNC_IDENTITY_CONFLICT',
        'Project marker does not match the configured project.',
      );
  } else {
    uuid(value.storeId, 'storeId');
    if (
      Object.keys(value).some(
        (key) =>
          ![
            'schemaVersion',
            'storeId',
            'scope',
            'projectId',
            'sessionId',
          ].includes(key),
      ) ||
      value.scope !== location!.scope ||
      value.projectId !== location!.projectId ||
      value.sessionId !== location!.sessionId
    )
      fail(
        'SYNC_IDENTITY_CONFLICT',
        'Store manifest does not match the configured scope/project/session.',
      );
  }
  return { bytes };
}
export async function localSources(
  root: string,
  owners: Owner[],
  markers: Map<string, string>,
): Promise<Map<string, Source>> {
  const sources = new Map<string, Source>();
  for (const owner of owners) {
    const snapshot = await readStore(owner.location);
    if (snapshot.warnings.length)
      fail(
        'SYNC_RECOVERY_REQUIRED',
        'Unpublished memory files need inspection before synchronization. Preserve them and review list/source diagnostics.',
      );
    const files =
      snapshot.fingerprint === 'empty'
        ? []
        : [
            path.join(owner.location.path, 'store.json'),
            ...snapshot.records.map((record) =>
              path.join(
                owner.location.path,
                'records',
                record.id,
                `${record.revisionId}.jsonl`,
              ),
            ),
          ];
    for (const file of files) {
      await regularFile(file);
      const name = relative(root, file);
      sources.set(
        name,
        decode(name, await readFile(file), managed(name, owners, markers)!),
      );
    }
  }
  for (const file of markers.keys()) {
    await regularFile(path.join(root, file));
    sources.set(
      file,
      decode(
        file,
        await readFile(path.join(root, file)),
        managed(file, owners, markers)!,
      ),
    );
  }
  validateUnion(sources, owners);
  return sources;
}
export interface TreeFile {
  mode: string;
  oid: string;
  file: string;
}
export async function treeFiles(
  git: Git,
  commit: string,
  owners: Owner[],
  markers: Map<string, string>,
): Promise<TreeFile[]> {
  const prefixes = [
    ...new Set([...owners.map((owner) => owner.prefix), ...markers.keys()]),
  ];
  const args = prefixes.includes('') ? [] : ['--', ...prefixes];
  const output = await git.text([
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    ...args,
  ]);
  if (!output) return [];
  return output
    .split('\0')
    .filter(Boolean)
    .flatMap((entry) => {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(entry);
      if (!match)
        fail('INVALID_GIT_TREE', 'Git returned an unsupported tree entry.');
      if (!managed(match[4]!, owners, markers)) return [];
      if (match[1] !== '100644' || match[2] !== 'blob')
        fail(
          'UNSAFE_SYNC_PATH',
          'Managed Git paths must be ordinary non-executable files, not links or submodules.',
        );
      return [{ mode: match[1]!, oid: match[3]!, file: match[4]! }];
    });
}
export async function blobs(
  git: Git,
  files: TreeFile[],
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(files.map((file) => file.oid))];
  for (let offset = 0; offset < unique.length; offset += 128) {
    const batch = unique.slice(offset, offset + 128);
    const bytes = await git.run(
      ['cat-file', '--batch'],
      Buffer.from(`${batch.join('\n')}\n`),
    );
    let cursor = 0;
    for (const expected of batch) {
      const newline = bytes.indexOf(10, cursor);
      const header = bytes
        .subarray(cursor, newline)
        .toString('ascii')
        .split(' ');
      const size = Number(header[2]);
      if (
        newline < 0 ||
        header[0] !== expected ||
        header[1] !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 262144 ||
        newline + 1 + size >= bytes.length
      )
        fail(
          'INVALID_SYNC_SOURCE',
          'Missing, oversized or invalid Git memory blob.',
        );
      result.set(expected, bytes.subarray(newline + 1, newline + 1 + size));
      cursor = newline + size + 2;
    }
  }
  return result;
}
export async function gitSources(
  git: Git,
  commit: string,
  owners: Owner[],
  markers: Map<string, string>,
): Promise<Map<string, Source>> {
  const files = await treeFiles(git, commit, owners, markers);
  const content = await blobs(git, files);
  const result = new Map<string, Source>();
  for (const item of files)
    result.set(
      item.file,
      decode(
        item.file,
        content.get(item.oid)!,
        managed(item.file, owners, markers)!,
      ),
    );
  validateUnion(result, owners);
  return result;
}
export function union(
  left: Map<string, Source>,
  right: Map<string, Source>,
): Map<string, Source> {
  const result = new Map(left);
  for (const [file, source] of right) {
    const previous = result.get(file);
    if (previous && normalized(previous.bytes) !== normalized(source.bytes))
      fail(
        'IMMUTABLE_CONFLICT',
        'The same immutable path has different content. Preserve both histories and inspect the fetched recovery ref before merging.',
      );
    result.set(file, source);
  }
  return result;
}
export function validateUnion(
  sources: Map<string, Source>,
  owners: Owner[],
): void {
  const revisions = new Set<string>();
  const identities = new Map<string, string>();
  for (const [file, source] of sources) {
    if (!source.record) continue;
    const owner = owners.find(
      (entry) =>
        file ===
        [
          entry.prefix,
          'records',
          source.record!.id,
          `${source.record!.revisionId}.jsonl`,
        ]
          .filter(Boolean)
          .join('/'),
    );
    if (!owner)
      fail('SYNC_IDENTITY_CONFLICT', 'A revision has no selected owner.');
    if (
      !sources.has(owner.prefix ? `${owner.prefix}/store.json` : 'store.json')
    )
      fail('SYNC_IDENTITY_CONFLICT', 'Revision history has no store manifest.');
    const key = source.record.id;
    if (
      revisions.has(source.record.revisionId) ||
      (identities.has(key) && identities.get(key) !== owner.location.path)
    )
      fail(
        'SYNC_IDENTITY_CONFLICT',
        'Duplicate memory/revision IDs across stores.',
      );
    revisions.add(source.record.revisionId);
    identities.set(key, owner.location.path);
  }
  for (const owner of owners) {
    const records = [...sources]
      .filter(
        ([file, source]) =>
          source.record &&
          (owner.prefix
            ? file.startsWith(`${owner.prefix}/records/`)
            : file.startsWith('records/')),
      )
      .map(([, source]) => source.record!);
    if (projectHeads(records).some((entry) => entry.conflict))
      fail(
        'SEMANTIC_CONFLICT',
        'Competing memory revisions (including delete/update races) require explicit resolution. Both histories were retained; inspect the fetched recovery ref and list --history --status all. No push was performed.',
      );
  }
}
