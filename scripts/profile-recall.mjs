import { subscribe } from 'node:diagnostics_channel';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

// Loaded with node --import only by isolated benchmark subprocesses. Includes
// startup before ESM imports via performance.timeOrigin. Never logs file names.
if (isMainThread) {
  const spans = {};
  const io = {};
  subscribe(
    'membrain.performance',
    ({ name, durationMs, calls = 1, bytes = 0 }) => {
      if (name.startsWith('fs.')) {
        const item = (io[name.slice(3)] ??= { calls: 0, totalMs: 0, bytes: 0 });
        item.calls += calls;
        item.totalMs += durationMs;
        item.bytes += bytes;
        return;
      }
      const item = (spans[name] ??= { calls: 0, totalMs: 0 });
      item.calls += calls;
      item.totalMs += durationMs;
    },
  );
  for (const name of [
    'lstat',
    'readdir',
    'readFile',
    'copyFile',
    'realpath',
    'mkdir',
    'rename',
    'unlink',
  ]) {
    const originalPromise = fsPromises[name];
    fsPromises[name] = async (...args) => {
      const start = performance.now();
      const item = (io[name] ??= { calls: 0, totalMs: 0, bytes: 0 });
      item.calls++;
      try {
        const result = await originalPromise(...args);
        if (name === 'readFile') item.bytes += Buffer.byteLength(result);
        return result;
      } finally {
        item.totalMs += performance.now() - start;
      }
    };
    const originalCallback = fs[name];
    fs[name] = (...args) => {
      const callback = args.pop();
      const start = performance.now();
      const item = (io[name] ??= { calls: 0, totalMs: 0, bytes: 0 });
      item.calls++;
      return originalCallback(...args, (error, result) => {
        item.totalMs += performance.now() - start;
        if (!error && name === 'readFile')
          item.bytes += Buffer.byteLength(result);
        callback(error, result);
      });
    };
  }
  syncBuiltinESMExports();
  process.on('exit', () => {
    process.stderr.write(
      `MEMBRAIN_PROFILE ${JSON.stringify({
        elapsedMs: performance.now(),
        spans,
        io,
        memory: process.memoryUsage(),
        resources: process.resourceUsage(),
      })}\n`,
    );
  });
}
