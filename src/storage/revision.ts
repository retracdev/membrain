import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fail, uuid, validateRevision } from '../engine/model.js';
import type { Revision, Warning } from '../engine/model.js';
import type { Location } from '../engine/scopes.js';
import { span } from '../profile.js';

export interface SourceFile {
  file: string;
  id: string;
  revisionId: string;
}
export interface LoadedRevision {
  record: Revision;
  hash: string;
}
export function temporary(file: string, warnings: Warning[]): boolean {
  if (!file.endsWith('.membrain-tmp')) return false;
  warnings.push({
    code: 'UNPUBLISHED_FILE',
    message: `Unpublished temporary file: ${file}. Inspect it before any manual cleanup.`,
  });
  return true;
}
export function sourceFile(
  entry: Dirent,
  directory: string,
  id: string,
  warnings: Warning[],
): SourceFile | undefined {
  const file = path.join(directory, entry.name);
  if (temporary(file, warnings)) return undefined;
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    !entry.name.endsWith('.jsonl')
  )
    fail('CORRUPT_STORE', `Unexpected source file at ${file}.`);
  const revisionId = entry.name.slice(0, -6);
  try {
    uuid(revisionId);
  } catch {
    fail('CORRUPT_STORE', `Invalid revision filename at ${file}.`);
  }
  return { file, id, revisionId };
}
export function decodeRevision(
  bytes: Buffer,
  source: SourceFile,
  location: Location,
): LoadedRevision {
  try {
    const finish = span('store.validationCpu');
    if (bytes.length > 262_144) throw new Error('Oversized source');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const normalized = content.endsWith('\r\n')
      ? `${content.slice(0, -2)}\n`
      : content;
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n'))
      throw new Error('Incomplete JSONL');
    const record = validateRevision(JSON.parse(content) as unknown);
    if (
      record.id !== source.id ||
      record.revisionId !== source.revisionId ||
      record.scope !== location.scope ||
      record.projectId !== location.projectId ||
      record.sessionId !== location.sessionId
    )
      throw new Error('Identity mismatch');
    const hash = createHash('sha256').update(normalized).digest('hex');
    finish();
    return { record, hash };
  } catch {
    invalidRevision(source.file);
  }
}
export function invalidRevision(file: string): never {
  fail(
    'CORRUPT_STORE',
    `Invalid source revision at ${file}:1. Preserve it; no automatic repair was attempted.`,
  );
}
