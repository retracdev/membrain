import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { readStore } from '../dist/storage/store.js';

const count = Number(process.argv[2] ?? 10_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 50_000)
  throw new Error('Use an integer count from 1 to 50000.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-benchmark-'));
if (!directory.startsWith(path.join(os.tmpdir(), 'membrain-benchmark-')))
  throw new Error('Unexpected benchmark cleanup path.');
try {
  const source = path.join(directory, 'source');
  const records = path.join(source, 'records');
  const cache = path.join(directory, 'cache');
  await mkdir(records, { recursive: true });
  await writeFile(
    path.join(source, 'store.json'),
    JSON.stringify({
      schemaVersion: 1,
      storeId: randomUUID(),
      scope: 'global',
    }),
  );
  const configFile = path.join(directory, 'config.json');
  const configValue = { version: 1, global: { path: source } };
  await writeFile(configFile, JSON.stringify(configValue));
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < count) {
        const i = next++;
        const id = randomUUID();
        const revisionId = randomUUID();
        const firstAt = '2026-01-01T00:00:00.000Z';
        const base = {
          schemaVersion: 1,
          id,
          revisionId,
          parentRevisionIds: [],
          content: `original benchmark memory ${i}`,
          scope: 'global',
          type: 'fact',
          createdAt: firstAt,
          updatedAt: firstAt,
          tags: ['benchmark'],
          metadata: {},
          status: 'active',
        };
        const current = {
          ...base,
          revisionId: randomUUID(),
          parentRevisionIds: [revisionId],
          content: `sqlite benchmark current memory ${i}`,
          updatedAt: '2026-01-01T00:00:00.001Z',
        };
        const folder = path.join(records, id);
        await mkdir(folder);
        await Promise.all([
          writeFile(
            path.join(folder, `${base.revisionId}.jsonl`),
            `${JSON.stringify(base)}\n`,
          ),
          writeFile(
            path.join(folder, `${current.revisionId}.jsonl`),
            `${JSON.stringify(current)}\n`,
          ),
        ]);
      }
    }),
  );
  const engine = new MemoryEngine(
    parseConfig(configValue, configFile),
    directory,
    cache,
  );
  let start = performance.now();
  const replay = await readStore({ path: source, scope: 'global' });
  const replayMs = performance.now() - start;
  if (replay.entries.length !== count)
    throw new Error('Benchmark replay lost records.');
  start = performance.now();
  const cold = await engine.query(
    { scope: 'global' },
    { query: 'sqlite', limit: 5 },
  );
  const coldSearchMs = performance.now() - start;
  start = performance.now();
  const warm = await engine.query(
    { scope: 'global' },
    { query: 'sqlite', limit: 5 },
  );
  const warmSearchMs = performance.now() - start;
  if (cold.results.length !== 5 || warm.index.rebuilt)
    throw new Error('Benchmark query/cache validation failed.');
  start = performance.now();
  const saved = await engine.remember(
    { scope: 'global' },
    { content: 'additional sqlite benchmark memory' },
  );
  const saveMs = performance.now() - start;
  if (saved.warnings.length)
    throw new Error('Benchmark save did not finish indexing.');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  start = performance.now();
  const cliResult = spawnSync(
    process.execPath,
    [cli, '--config', configFile, '--json', 'recall', 'sqlite'],
    {
      env: { ...process.env, PATH: '', MEMBRAIN_CACHE_DIR: cache },
      encoding: 'utf8',
    },
  );
  const cliRecallMs = performance.now() - start;
  if (cliResult.status !== 0) throw new Error(cliResult.stderr);
  const recall = JSON.parse(cliResult.stdout);
  if (JSON.stringify(recall.results).length > 4000)
    throw new Error('Recall exceeded its budget.');
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        activeMemories: count,
        sourceRevisions: count * 2,
        replayMs: Math.round(replayMs),
        coldSearchMs: Math.round(coldSearchMs),
        warmSearchMs: Math.round(warmSearchMs),
        saveWithIndexMs: Math.round(saveMs),
        cliRecallMs: Math.round(cliRecallMs),
        recallResults: recall.results.length,
        recallResultCharacters: JSON.stringify(recall.results).length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
