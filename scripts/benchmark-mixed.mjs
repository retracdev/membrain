import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseConfig } from '../dist/config.js';
import { populateFixture } from '../fixtures/performance-store.mjs';

const count = Number(process.argv[2] ?? 1000);
const samples = Number(process.argv[3] ?? 30);
if (
  !Number.isSafeInteger(count) ||
  count < 10 ||
  count > 50000 ||
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  samples > 100
)
  throw new Error('Use 10..50000 memories and 1..100 samples.');
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    Math.round(sorted[Math.ceil(sorted.length * p) - 1]);
  return {
    samples: values.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: percentile(1),
    valuesMs: values.map(Math.round),
  };
}
const directory = await mkdtemp(
  path.join(os.tmpdir(), 'membrain-benchmark-mixed-'),
);
if (
  path.dirname(directory) !== os.tmpdir() ||
  !path.basename(directory).startsWith('membrain-benchmark-mixed-')
)
  throw new Error('Unsafe cleanup path.');
try {
  const cwd = path.join(directory, 'alpha');
  await mkdir(cwd);
  await mkdir(path.join(directory, 'beta'));
  const configFile = path.join(directory, 'config.json');
  const value = {
    version: 1,
    global: { path: './global' },
    projects: [
      { projectId: 'alpha', root: './alpha', path: './project-alpha' },
      { projectId: 'beta', root: './beta', path: './project-beta' },
    ],
    session: { path: './sessions' },
  };
  await writeFile(configFile, JSON.stringify(value));
  console.error(`Preparing ${count} mixed-scope synthetic memories...`);
  const records = await populateFixture(
    parseConfig(value, configFile),
    directory,
    count,
  );
  const selectedMemories = records.filter(
    ({ location }) =>
      location.scope === 'global' ||
      (location.projectId === 'alpha' && location.sessionId !== 'hidden'),
  ).length;
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const cache = path.join(directory, 'cache');
  function recall(profile = false) {
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        ...(profile
          ? ['--import', new URL('./profile-recall.mjs', import.meta.url).href]
          : []),
        cli,
        '--config',
        configFile,
        '--json',
        'recall',
        'sqlite',
        '--session',
        'work',
      ],
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          PATH: '',
          MEMBRAIN_CACHE_DIR: cache,
        },
        encoding: 'utf8',
        timeout: 900000,
      },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || String(result.error));
    const elapsedMs = performance.now() - start;
    const data = JSON.parse(result.stdout);
    if (
      data.index.revisions !== selectedMemories * 2 ||
      data.results.length !== Math.min(5, selectedMemories) ||
      JSON.stringify(data.results).length > 4000
    )
      throw new Error('Unexpected corpus or budget.');
    for (const hit of data.results)
      if (hit.projectId === 'beta' || hit.sessionId === 'hidden')
        throw new Error('Scope leak.');
    const line = result.stderr
      .split('\n')
      .find((item) => item.startsWith('MEMBRAIN_PROFILE '));
    return {
      elapsedMs,
      data,
      profile: line ? JSON.parse(line.slice(17)) : undefined,
    };
  }
  const coldMs = [];
  for (let i = 0; i < 3; i++) {
    await rm(cache, { recursive: true, force: true });
    const cold = recall();
    if (!cold.data.index.rebuilt)
      throw new Error('Cold recall did not rebuild.');
    coldMs.push(cold.elapsedMs);
    console.error(`Mixed cold ${i + 1}/3: ${Math.round(cold.elapsedMs)} ms`);
  }
  recall();
  const warmMs = [];
  for (let i = 0; i < samples; i++) {
    const warm = recall();
    if (warm.data.index.rebuilt) throw new Error('Unchanged recall rebuilt.');
    warmMs.push(warm.elapsedMs);
    console.error(
      `Mixed warm ${i + 1}/${samples}: ${Math.round(warm.elapsedMs)} ms`,
    );
  }
  const warmProfile = recall(true).profile;
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        timestamp: new Date().toISOString(),
        activeMemories: count,
        selectedMemories,
        sourceRevisions: selectedMemories * 2,
        coldCliRecall: summary(coldMs),
        coldCliRecallMs: Math.round(coldMs[0]),
        warmCliRecall: summary(warmMs),
        warmProfile,
        osCaches:
          'not evicted; fixture preparation and earlier queries warm caches',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
