import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { readStore, appendRevision } from '../dist/storage/store.js';
import { withLock, publish } from '../dist/storage/files.js';

const writer = fileURLToPath(
  new URL('../fixtures/writer.mjs', import.meta.url),
);
const crasher = fileURLToPath(
  new URL('../fixtures/crash.mjs', import.meta.url),
);
async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'membrain-concurrency-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'config.json');
  const value = { version: 1, global: { path: './memory' } };
  await writeFile(filename, JSON.stringify(value));
  const config = parseConfig(value, filename);
  const cache = path.join(directory, 'cache');
  return {
    directory,
    filename,
    config,
    cache,
    engine: new MemoryEngine(config, directory, cache),
  };
}
function child(fixture, mode, label, id = '', expected = '') {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      [writer, fixture.filename, mode, label, id, expected],
      {
        env: { ...process.env, PATH: '', MEMBRAIN_CACHE_DIR: fixture.cache },
        cwd: fixture.directory,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    processChild.stdout.on('data', (part) => {
      stdout += part;
    });
    processChild.stderr.on('data', (part) => {
      stderr += part;
    });
    processChild.on('error', reject);
    processChild.on('close', (status) => {
      try {
        resolve({ status, data: JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`Child failed: ${status} ${stderr} ${stdout}`));
      }
    });
  });
}

test(
  '20 simultaneous processes preserve all independent writes and complete JSONL',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        child(f, 'create', String(index)),
      ),
    );
    assert.ok(
      results.every((result) => result.status === 0),
      JSON.stringify(results.filter((result) => result.status !== 0)),
    );
    const data = await f.engine.query({ scope: 'global' }, { limit: 100 });
    assert.equal(data.results.length, 20);
    assert.equal(new Set(data.results.map((item) => item.record.id)).size, 20);
    const snapshot = await readStore({
      path: f.config.global.path,
      scope: 'global',
    });
    assert.equal(snapshot.records.length, 20);
    assert.equal(snapshot.warnings.length, 0);
  },
);

test(
  '20 simultaneous updates with one expected head accept exactly one winner',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const saved = await f.engine.remember(
      { scope: 'global' },
      { content: 'baseline revision' },
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        child(
          f,
          'update',
          String(index),
          saved.record.id,
          saved.record.revisionId,
        ),
      ),
    );
    assert.equal(results.filter((result) => result.status === 0).length, 1);
    assert.ok(
      results
        .filter((result) => result.status !== 0)
        .every((result) => result.data.error.code === 'STALE_REVISION'),
    );
    assert.equal(
      (await readStore({ path: f.config.global.path, scope: 'global' })).records
        .length,
      2,
    );
  },
);

test(
  '20 duplicate retries create only one stable memory and revision',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        child(f, 'retry', String(index)),
      ),
    );
    assert.ok(results.every((result) => result.status === 0));
    assert.equal(
      new Set(results.map((result) => result.data.record.id)).size,
      1,
    );
    assert.equal(
      (await readStore({ path: f.config.global.path, scope: 'global' })).records
        .length,
      1,
    );
  },
);

test(
  'termination before/after publication preserves only complete records and reports recovery',
  { timeout: 30_000 },
  async (t) => {
    for (const stage of ['flushed', 'published']) {
      const f = await fixture(t);
      const saved = await f.engine.remember(
        { scope: 'global' },
        { content: 'crash baseline' },
      );
      const revision = {
        ...saved.record,
        revisionId: randomUUID(),
        parentRevisionIds: [saved.record.revisionId],
        content: 'complete crash revision',
        updatedAt: new Date(
          Date.parse(saved.record.updatedAt) + 10,
        ).toISOString(),
      };
      const filename = path.join(
        f.config.global.path,
        'records',
        revision.id,
        `${revision.revisionId}.jsonl`,
      );
      const worker = spawn(
        process.execPath,
        [
          crasher,
          f.config.global.path,
          filename,
          stage,
          `${JSON.stringify(revision)}\n`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      t.after(() => {
        if (worker.exitCode === null) worker.kill();
      });
      const exited = once(worker, 'exit');
      await once(worker, 'message');
      worker.kill('SIGKILL');
      await exited;
      const snapshot = await readStore({
        path: f.config.global.path,
        scope: 'global',
      });
      assert.equal(snapshot.records.length, stage === 'flushed' ? 1 : 2);
      assert.ok(
        snapshot.warnings.some((item) => item.code === 'UNPUBLISHED_FILE'),
      );
      await assert.rejects(
        withLock(f.config.global.path, async () => {}, 100),
        { code: 'LOCK_BUSY' },
      );
      // This isolated process is known to have exited. Recovery never touches source revisions.
      const lock = path.join(f.config.global.path, '.membrain-lock');
      const owner = JSON.parse(
        await readFile(path.join(lock, 'owner.json'), 'utf8'),
      );
      assert.equal(owner.pid, worker.pid);
      await rm(lock, { recursive: true });
      await f.engine.remember(
        { scope: 'global' },
        { content: `write after inspected ${stage} crash` },
      );
      assert.equal(
        (await f.engine.query({ scope: 'global' }, { limit: 100 })).results
          .length,
        2,
      );
    }
  },
);

test('publication never overwrites existing bytes, even when called without a lock', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'immutable.jsonl');
  await publish(filename, 'first\n');
  await assert.rejects(publish(filename, 'second\n'), { code: 'EEXIST' });
  assert.equal(await readFile(filename, 'utf8'), 'first\n');
  assert.equal(
    (await readdir(f.directory)).some((item) => item.endsWith('.membrain-tmp')),
    false,
  );
});

test('an error for an already complete publication reports the saved identity for review', async (t) => {
  const f = await fixture(t);
  const saved = await f.engine.remember(
    { scope: 'global' },
    { content: 'already complete bytes' },
  );
  const location = { path: f.config.global.path, scope: 'global' };
  const warnings = await appendRevision(location, saved.record, async () => {});
  assert.equal(warnings[0].code, 'PUBLICATION_CHECK_REQUIRED');
  assert.match(warnings[0].message, new RegExp(saved.record.id));
  assert.equal((await readStore(location)).records.length, 1);
});
