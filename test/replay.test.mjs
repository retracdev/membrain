import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  lstat,
  utimes,
  readdir,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { fileURLToPath, URL } from 'node:url';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { readStore } from '../dist/storage/store.js';
import { populateFixture } from '../fixtures/performance-store.mjs';

test('parallel replay preserves deterministic recovery, full verification and permission-safe fallback', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'membrain-replay-test-'),
  );
  assert.equal(path.dirname(directory), os.tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const config = parseConfig(
    { version: 1, global: { path: './source' } },
    path.join(directory, 'config.json'),
  );
  const records = await populateFixture(config, directory, 1000, [
    { scope: 'global' },
  ]);
  const location = records[0].location;
  const timing = {};
  const snapshot = await readStore(location, timing);
  assert.equal(timing.strategy, 'workers');
  assert.equal(snapshot.records.length, 2000);
  assert.equal(snapshot.entries.length, 1000);
  let active = 0;
  let peak = 0;
  const listener = ({ name }) => {
    if (name === 'store.workerStart') peak = Math.max(peak, ++active);
    if (name === 'store.workerExit') active--;
  };
  subscribe('membrain.performance', listener);
  try {
    const simultaneous = await Promise.all([
      readStore(location),
      readStore(location),
    ]);
    for (const item of simultaneous)
      assert.equal(item.fingerprint, snapshot.fingerprint);
    assert.ok(peak > 0 && peak <= 8);
    assert.equal(active, 0);
  } finally {
    unsubscribe('membrain.performance', listener);
  }
  const reader = fileURLToPath(
    new URL('../fixtures/replay-reader.mjs', import.meta.url),
  );
  const profile = new URL('../scripts/profile-recall.mjs', import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=*',
      '--import',
      profile,
      reader,
      location.path,
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: '', PATH: '' },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const fallback = JSON.parse(result.stdout);
  assert.equal(fallback.fingerprint, snapshot.fingerprint);
  assert.equal(fallback.revisions, 2000);
  assert.equal(fallback.heads, 1000);
  const diagnostic = JSON.parse(
    result.stderr
      .split('\n')
      .find((line) => line.startsWith('MEMBRAIN_PROFILE '))
      .slice(17),
  );
  assert.equal(diagnostic.spans['store.workerFallback'].calls, 1);
  assert.equal(diagnostic.spans['store.validationCpu'].calls, 2000);
  const threaded = spawnSync(
    process.execPath,
    ['--import', profile, reader, location.path],
    {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: '', PATH: '' },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  assert.equal(threaded.status, 0, threaded.stderr);
  assert.equal(JSON.parse(threaded.stdout).fingerprint, snapshot.fingerprint);
  const profiles = threaded.stderr
    .split('\n')
    .filter((line) => line.startsWith('MEMBRAIN_PROFILE '));
  assert.equal(profiles.length, 1);
  const metrics = JSON.parse(profiles[0].slice(17));
  assert.equal(metrics.spans['store.workerStart'].calls, 8);
  assert.equal(metrics.spans['store.workerExit'].calls, 8);
  assert.equal(metrics.spans['store.validationCpu'].calls, 2000);
  assert.equal(metrics.io.readFileSync.calls, 2000);
  const engine = new MemoryEngine(
    config,
    directory,
    path.join(directory, 'cache'),
  );
  const query = (options = {}) =>
    engine.query(
      { scope: 'global' },
      { query: 'sqlite', limit: 10, ...options },
    );
  const initial = await query();
  assert.equal((await query({ readOnly: true })).index.rebuilt, false);
  const index = await readFile(initial.index.path);
  const selected = records[0];
  const folder = path.join(location.path, 'records', selected.current.id);
  const source = path.join(folder, `${selected.current.revisionId}.jsonl`);
  const original = await readFile(source, 'utf8');
  const stat = await lstat(source);
  await writeFile(source, original.replace('current', 'changed'));
  await utimes(source, stat.atime, stat.mtime);
  await assert.rejects(query(), { code: 'CORRUPT_STORE' });
  assert.deepEqual(await readFile(initial.index.path), index);
  await writeFile(source, Buffer.from([0xff, 0x0a]));
  await assert.rejects(query(), { code: 'CORRUPT_STORE' });
  await writeFile(source, original);
  const tombstone = {
    ...selected.current,
    revisionId: randomUUID(),
    parentRevisionIds: [selected.current.revisionId],
    updatedAt: '2026-01-01T00:00:00.002Z',
    status: 'deleted',
  };
  await writeFile(
    path.join(folder, `${tombstone.revisionId}.jsonl`),
    `${JSON.stringify(tombstone)}\n`,
  );
  await assert.rejects(query({ readOnly: true }), { code: 'INDEX_READ_ONLY' });
  const changed = await query();
  assert.equal(changed.index.rebuilt, true);
  const before = await readStore(location);
  assert.equal(
    before.entries.find(({ record }) => record.id === tombstone.id).record
      .status,
    'deleted',
  );
  await rm(path.join(directory, 'cache'), { recursive: true });
  const recovered = await query();
  assert.equal(recovered.index.rebuilt, true);
  assert.deepEqual(recovered.results, changed.results);
  assert.equal((await readStore(location)).fingerprint, before.fingerprint);
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith('.membrain-lock')),
    false,
  );
});
