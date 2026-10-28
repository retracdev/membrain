import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';
import { parseConfig } from '../dist/config.js';
import { populateFixture } from '../fixtures/performance-store.mjs';

// Compare verified replay strategies against the exact same source/index. The
// Both warm routes use the same permission model, toggling worker permission
// while retaining ordinary read-only filesystem/SQLite access.
const count = Number(process.argv[2] ?? 1000);
const samples = Number(process.argv[3] ?? 5);
assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 10000);
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 30);
const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-compare-'));
assert.equal(path.dirname(directory), os.tmpdir());
assert.ok(path.basename(directory).startsWith('membrain-compare-'));
try {
  await mkdir(path.join(directory, '.git')); // Bound discovery to this fixture.
  const configFile = path.join(directory, 'config.json');
  const value = { version: 1, global: { path: './source' } };
  await writeFile(configFile, JSON.stringify(value));
  await populateFixture(parseConfig(value, configFile), directory, count, [
    { scope: 'global' },
  ]);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    PATH: '',
    MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
  };
  const baseArgs = [
    cli,
    '--config',
    configFile,
    '--json',
    'recall',
    'sqlite',
    '--scope',
    'global',
  ];
  function recall(fallback = false, profile = false, cold = false) {
    const start = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        ...(cold
          ? []
          : [
              '--permission',
              '--allow-fs-read=*',
              '--allow-addons',
              ...(fallback ? [] : ['--allow-worker']),
            ]),
        ...(profile
          ? ['--import', new URL('./profile-recall.mjs', import.meta.url).href]
          : []),
        ...baseArgs,
        ...(cold ? [] : ['--read-only']),
      ],
      { cwd: directory, env, encoding: 'utf8', timeout: 180000 },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const elapsedMs = performance.now() - start;
    const data = JSON.parse(child.stdout);
    assert.equal(data.index.rebuilt, cold);
    const line = child.stderr
      .split('\n')
      .find((item) => item.startsWith('MEMBRAIN_PROFILE '));
    return {
      elapsedMs,
      results: data.results,
      profile: line ? JSON.parse(line.slice(17)) : undefined,
    };
  }
  const expected = recall(false, false, true).results;
  recall();
  recall(true);
  const values = { workers: [], ordinary: [] };
  for (let round = 0; round < samples; round++) {
    for (const fallback of round % 2 ? [true, false] : [false, true]) {
      const result = recall(fallback);
      assert.deepEqual(result.results, expected);
      const strategy = fallback ? 'ordinary' : 'workers';
      values[strategy].push(Math.round(result.elapsedMs));
      console.error(
        JSON.stringify({
          round,
          strategy,
          elapsedMs: Math.round(result.elapsedMs),
        }),
      );
    }
  }
  const report = {
    node: process.version,
    platform: process.platform,
    count,
    samples,
    values,
    workerProfile: recall(false, true).profile,
    ordinaryProfile: recall(true, true).profile,
    caveat:
      'Same fixture and permission model, alternating processes; worker permission toggled. Desktop and OS caches uncontrolled.',
  };
  assert.equal(report.workerProfile.spans['store.workerStart'].calls, 8);
  assert.equal(report.ordinaryProfile.spans['store.workerFallback'].calls, 1);
  const output = new URL('../coverage/performance/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL(`compare-${count}.json`, output),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
