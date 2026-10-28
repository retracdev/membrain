import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { subscribe } from 'node:diagnostics_channel';
import path from 'node:path';
import { fail } from '../engine/model.js';
import type { Warning } from '../engine/model.js';
import type { Location } from '../engine/scopes.js';
import { MembrainError } from '../errors.js';
import { decodeRevision, invalidRevision, sourceFile } from './revision.js';
import type { LoadedRevision } from './revision.js';

export interface ReplayJob {
  location: Location;
  directories: string[];
  profile: boolean;
}
export interface Metric {
  name: string;
  calls: number;
  durationMs: number;
  bytes?: number;
}
export interface ReplayChunk {
  loaded: LoadedRevision[];
  warnings: Warning[];
  metrics: Metric[];
}
export type ReplayReply =
  ReplayChunk | { error: { code: string; message: string } };

// This module runs only in short-lived, read-only workers created by replay.ts.
const job = workerData as ReplayJob;
const metrics = new Map<string, Metric>();
function metric(name: string, durationMs: number, bytes = 0): void {
  if (!job.profile) return;
  const value = metrics.get(name) ?? {
    name,
    calls: 0,
    durationMs: 0,
    bytes: 0,
  };
  value.calls++;
  value.durationMs += durationMs;
  value.bytes = (value.bytes ?? 0) + bytes;
  metrics.set(name, value);
}
function io<T>(name: string, action: () => T): T {
  if (!job.profile) return action();
  const start = performance.now();
  const value = action();
  metric(
    name,
    performance.now() - start,
    Buffer.isBuffer(value) ? value.length : 0,
  );
  return value;
}
if (job.profile)
  subscribe('membrain.performance', (event) => {
    const { name, durationMs } = event as { name: string; durationMs: number };
    metric(name, durationMs);
  });
try {
  const loaded: LoadedRevision[] = [];
  const warnings: Warning[] = [];
  for (const id of job.directories) {
    const directory = path.join(job.location.path, 'records', id);
    const stat = io('fs.lstatSync', () => lstatSync(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('CORRUPT_STORE', `Unexpected source path at ${directory}.`);
    const entries = io('fs.readdirSync', () =>
      readdirSync(directory, { withFileTypes: true }),
    );
    for (const entry of entries) {
      const source = sourceFile(entry, directory, id, warnings);
      if (!source) continue;
      try {
        const stat = io('fs.lstatSync', () => lstatSync(source.file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144)
          invalidRevision(source.file);
        const bytes = io('fs.readFileSync', () => readFileSync(source.file));
        loaded.push(decodeRevision(bytes, source, job.location));
      } catch {
        invalidRevision(source.file);
      }
    }
  }
  parentPort!.postMessage({
    loaded,
    warnings,
    metrics: [...metrics.values()],
  } satisfies ReplayChunk);
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof MembrainError
        ? { code: error.code, message: error.message }
        : {
            code: 'CORRUPT_STORE',
            message:
              'Cannot read authoritative source directories. Check source paths and permissions; preserve the source files.',
          },
  } satisfies ReplayReply);
}
