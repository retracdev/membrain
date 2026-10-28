import { Worker } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
import type { Location } from '../engine/scopes.js';
import { MembrainError } from '../errors.js';
import type { ReplayChunk, ReplayJob, ReplayReply } from './replay-worker.js';

// Shared by all stores in this process, including --all-projects queries.
// No idle workers survive a replay. Queued stores cannot multiply the cap.
const limit = 8;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(action: () => Promise<T>): Promise<T> {
  if (active < limit) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await action();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
async function run(job: ReplayJob): Promise<ReplayChunk> {
  return slot(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(
          new URL('./replay-worker.js', import.meta.url),
          { workerData: job },
        );
        const lifecycle = channel('membrain.performance');
        lifecycle.publish({
          name: 'store.workerStart',
          durationMs: 0,
          calls: 1,
        });
        let reply: ReplayReply | undefined;
        let failed = false;
        worker.once('message', (value: ReplayReply) => {
          reply = value;
        });
        worker.once('error', () => {
          failed = true;
        });
        worker.once('exit', (code) => {
          lifecycle.publish({
            name: 'store.workerExit',
            durationMs: 0,
            calls: 1,
          });
          if (failed || code !== 0 || !reply) {
            reject(
              new MembrainError(
                'REPLAY_FAILED',
                'Source replay worker exited before verification completed. Retry with sufficient memory; source records were not changed.',
              ),
            );
          } else if ('error' in reply)
            reject(new MembrainError(reply.error.code, reply.error.message));
          else resolve(reply);
        });
      }),
  );
}
export async function replayDirectories(
  location: Location,
  directories: string[],
  known?: Map<string, string[]>,
  inventory = false,
): Promise<ReplayChunk | undefined> {
  const timing = channel('membrain.performance');
  const chunks: string[][] = Array.from(
    { length: Math.min(limit, directories.length) },
    () => [],
  );
  directories.forEach((directory, i) =>
    chunks[i % chunks.length]!.push(directory),
  );
  // Drain every worker, including on failure, before releasing the caller's
  // store lock or letting a fixture clean up source directories.
  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      run({
        location,
        directories: chunk,
        profile: timing.hasSubscribers,
        inventory,
        ...(known ? { known: chunk.flatMap((id) => known.get(id) ?? []) } : {}),
      }),
    ),
  );
  for (const result of results)
    if (
      result.status === 'rejected' &&
      result.reason instanceof MembrainError &&
      result.reason.code === 'CORRUPT_STORE'
    )
      throw result.reason;
  if (results.some((result) => result.status === 'rejected')) {
    // Worker permissions/resources may be unavailable. A complete ordinary
    // replay is safe; no cached data or incomplete worker output is reused.
    timing.publish({ name: 'store.workerFallback', durationMs: 0, calls: 1 });
    return undefined;
  }
  const loaded: ReplayChunk['loaded'] = [];
  const reused: string[] = [];
  const warnings: ReplayChunk['warnings'] = [];
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    for (const item of result.value.loaded) loaded.push(item);
    reused.push(...result.value.reused);
    for (const warning of result.value.warnings) warnings.push(warning);
    for (const metric of result.value.metrics) timing.publish(metric);
  }
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
  return { loaded, reused, warnings, metrics: [] };
}
