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
import { queryIndex } from '../dist/index/search.js';

const count = Number(process.argv[2] ?? 10_000);
const samples = Number(process.argv[3] ?? 30);
if (!Number.isSafeInteger(count) || count < 1 || count > 50_000)
  throw new Error('Use an integer count from 1 to 50000.');
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100)
  throw new Error(
    'Use a sample count from 1 to 100 (30 for release measurements).',
  );
const topics = [
  [
    'Prefer TypeScript for Node.js services and React applications; enable strict checking.',
    ['typescript', 'languages'],
  ],
  [
    'Use SQLite FTS5 for offline retrieval; JSONL history remains authoritative.',
    ['sqlite', 'storage'],
  ],
  [
    'Authentication uses short-lived sessions; review access checks on every protected route.',
    ['authentication', 'security'],
  ],
  [
    'Run integration tests in disposable directories and preserve concurrent writer revisions.',
    ['testing', 'reliability'],
  ],
  [
    'Deployment requires a reviewed change and passing checks; retain rollback instructions.',
    ['deployment', 'operations'],
  ],
  [
    'Use dark mode with sufficient contrast and keyboard-accessible controls.',
    ['appearance', 'accessibility'],
  ],
  [
    'Project Atlas caches build artifacts locally; invalidate the cache when dependencies change.',
    ['atlas', 'builds'],
  ],
];
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    Math.round(sorted[Math.ceil(sorted.length * p) - 1]);
  return {
    samples: values.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
    valuesMs: values.map(Math.round),
  };
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-benchmark-'));
if (!directory.startsWith(path.join(os.tmpdir(), 'membrain-benchmark-')))
  throw new Error('Unexpected benchmark cleanup path.');
try {
  console.error(
    `Preparing ${count} synthetic memories with two revisions each...`,
  );
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
        const [content, tags] = topics[i % topics.length];
        const base = {
          schemaVersion: 1,
          id,
          revisionId,
          parentRevisionIds: [],
          content: `Earlier decision ${i}: ${content}`,
          scope: 'global',
          type: 'fact',
          createdAt: firstAt,
          updatedAt: firstAt,
          tags,
          metadata: {
            fixture: i,
            rationale: 'Synthetic release benchmark; no user memory.',
          },
          status: 'active',
        };
        const current = {
          ...base,
          revisionId: randomUUID(),
          parentRevisionIds: [revisionId],
          content: `Decision ${i}: ${content} Reviewed with the project maintainers after the implementation tests.`,
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
  console.error('Measuring complete source replay...');
  const engine = new MemoryEngine(
    parseConfig(configValue, configFile),
    directory,
    cache,
  );
  let start = performance.now();
  const replayTiming = {};
  const replay = await readStore(
    { path: source, scope: 'global' },
    replayTiming,
  );
  const replayMs = performance.now() - start;
  console.error(
    JSON.stringify({ replayMs: Math.round(replayMs), replayTiming }),
  );
  if (replay.entries.length !== count)
    throw new Error('Benchmark replay lost records.');
  console.error('Measuring SQLite separately from source replay...');
  start = performance.now();
  await queryIndex(
    [replay],
    { query: 'sqlite', limit: 5 },
    [source],
    path.join(directory, 'sql-only'),
  );
  const indexBuildAndQueryMs = performance.now() - start;
  start = performance.now();
  await queryIndex(
    [replay],
    { query: 'sqlite', limit: 5 },
    [source],
    path.join(directory, 'sql-only'),
  );
  const indexReuseAndQueryMs = performance.now() - start;
  console.error(
    JSON.stringify({
      indexBuildAndQueryMs: Math.round(indexBuildAndQueryMs),
      indexReuseAndQueryMs: Math.round(indexReuseAndQueryMs),
    }),
  );
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  function recall() {
    const start = performance.now();
    const cliResult = spawnSync(
      process.execPath,
      [cli, '--config', configFile, '--json', 'recall', 'sqlite'],
      {
        cwd: directory,
        env: { ...process.env, PATH: '', MEMBRAIN_CACHE_DIR: cache },
        encoding: 'utf8',
        timeout: 180_000,
      },
    );
    if (cliResult.status !== 0)
      throw new Error(cliResult.stderr || String(cliResult.error));
    const data = JSON.parse(cliResult.stdout);
    if (JSON.stringify(data.results).length > 4000)
      throw new Error('Recall exceeded its budget.');
    if (
      data.results.length !==
      Math.min(5, Math.ceil((count - 1) / topics.length))
    )
      throw new Error('Unexpected result count.');
    return { elapsedMs: performance.now() - start, data };
  }
  console.error(
    'Measuring first CLI recall with no index (OS caches are not evicted)...',
  );
  const cold = recall();
  console.error(`Cold CLI recall: ${Math.round(cold.elapsedMs)} ms`);
  if (!cold.data.index.rebuilt)
    throw new Error('Cold recall did not build its index.');
  // One excluded warmup, then independent processes, including startup and output.
  recall();
  const warmMs = [];
  for (let sample = 0; sample < samples; sample++) {
    const warm = recall();
    if (warm.data.index.rebuilt)
      throw new Error('Unchanged warm recall rebuilt its index.');
    warmMs.push(warm.elapsedMs);
    console.error(
      `Warm CLI recall ${sample + 1}/${samples}: ${Math.round(warm.elapsedMs)} ms`,
    );
  }
  console.error(JSON.stringify({ warmCliRecall: summary(warmMs) }));
  console.error('Measuring durable save and next visible recall...');
  start = performance.now();
  const saved = await engine.remember(
    { scope: 'global' },
    {
      content: 'Additional sqlite benchmark release decision',
      operationId: 'benchmark-save',
    },
  );
  const saveMs = performance.now() - start;
  if (saved.warnings.length)
    throw new Error('Benchmark save did not finish indexing.');
  start = performance.now();
  const visible = await engine.query(
    { scope: 'global' },
    { query: 'benchmark', limit: 5 },
  );
  const nextQueryMs = performance.now() - start;
  if (!visible.results.some((item) => item.record.id === saved.record.id))
    throw new Error('Saved record not visible.');
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalRamGiB: Math.round(os.totalmem() / 1024 ** 3),
        osCaches:
          'not evicted; fixture generation and replay precede cold-index recall',
        timestamp: new Date().toISOString(),
        activeMemories: count,
        sourceRevisions: count * 2,
        replayMs: Math.round(replayMs),
        replayTiming,
        indexBuildAndQueryMs: Math.round(indexBuildAndQueryMs),
        indexReuseAndQueryMs: Math.round(indexReuseAndQueryMs),
        coldCliRecallMs: Math.round(cold.elapsedMs),
        warmCliRecall: summary(warmMs),
        saveWithIndexMs: Math.round(saveMs),
        nextQueryMs: Math.round(nextQueryMs),
        recallResults: cold.data.results.length,
        recallResultCharacters: JSON.stringify(cold.data.results).length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
