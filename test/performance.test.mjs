import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  utimes,
  lstat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { MemoryEngine } from '../dist/engine/engine.js';
import { parseConfig } from '../dist/config.js';
import { populateFixture } from '../fixtures/performance-store.mjs';

test('large mixed stores reuse indexes, preserve scope/ranking, and detect external changes without timestamp trust', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'membrain-performance-'),
  );
  assert.equal(path.dirname(directory), os.tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(directory, 'alpha');
  await mkdir(root);
  await mkdir(path.join(directory, 'beta'));
  const config = parseConfig(
    {
      version: 1,
      global: { path: './global' },
      projects: [
        { projectId: 'alpha', root, path: './project-alpha' },
        { projectId: 'beta', root: './beta', path: './project-beta' },
      ],
      session: { path: './sessions' },
    },
    path.join(directory, 'config.json'),
  );
  const records = await populateFixture(config, directory);
  const cache = path.join(directory, 'cache');
  const engine = new MemoryEngine(config, root, cache);
  const selection = { session: 'work' };
  const options = { query: 'SQLite', limit: 100 };
  const initial = await engine.query(selection, options);
  assert.equal(initial.index.rebuilt, true);
  assert.equal(initial.index.revisions, 1200);
  const events = [];
  const listener = (event) => events.push(event);
  subscribe('membrain.performance', listener);
  try {
    const warm = await new MemoryEngine(config, root, cache).query(selection, {
      ...options,
      readOnly: true,
    });
    assert.equal(warm.index.rebuilt, false);
    assert.deepEqual(warm.results, initial.results);
    assert.equal(
      events.some(
        ({ name }) => name === 'index.build' || name === 'lock.acquire',
      ),
      false,
    );
    assert.equal(
      events
        .filter(({ name }) => name === 'store.validationCpu')
        .reduce((sum, event) => sum + (event.calls ?? 1), 0),
      1200,
    );
  } finally {
    unsubscribe('membrain.performance', listener);
  }
  for (const item of initial.results) {
    assert.notEqual(item.record.projectId, 'beta');
    assert.ok(
      item.record.sessionId === undefined || item.record.sessionId === 'work',
    );
    assert.equal(item.historical, false);
  }
  // External immutable child: both content and lifecycle must replace the head.
  const selected = records.find(
    ({ location }) =>
      location.scope === 'project' && location.projectId === 'alpha',
  );
  const folder = path.join(
    selected.location.path,
    'records',
    selected.current.id,
  );
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
  await assert.rejects(
    engine.query(selection, { ...options, readOnly: true }),
    { code: 'INDEX_READ_ONLY' },
  );
  const refreshed = await engine.query(selection, options);
  assert.equal(refreshed.index.rebuilt, true);
  const listed = await engine.query(
    { scope: 'project' },
    { limit: 100, state: 'deleted' },
  );
  const deleted = listed.results.find(
    ({ record }) => record.id === tombstone.id,
  );
  assert.equal(deleted.record.status, 'deleted');
  assert.equal(
    (
      await engine.query({ scope: 'project' }, { query: 'SQLite', limit: 100 })
    ).results.some(({ record }) => record.id === tombstone.id),
    false,
  );
  // An edit to any indexed ancestor must be rejected even if size/mtime match.
  const file = path.join(folder, `${selected.base.revisionId}.jsonl`);
  const original = await readFile(file, 'utf8');
  const stat = await lstat(file);
  await writeFile(file, original.replace('Historical', 'Manipulate'));
  await utimes(file, stat.atime, stat.mtime);
  await assert.rejects(engine.query(selection, options), {
    code: 'CORRUPT_STORE',
  });
  await writeFile(file, original);
  // Physical removal invalidates the selected corpus; no deleted cache hit.
  await rm(folder, { recursive: true });
  await assert.rejects(
    engine.query(selection, { ...options, readOnly: true }),
    { code: 'INDEX_READ_ONLY' },
  );
  const removed = await engine.query(selection, options);
  assert.equal(removed.index.rebuilt, true);
  assert.equal(removed.index.revisions, 1198);
  await rm(cache, { recursive: true });
  const recovered = await engine.query(selection, options);
  assert.equal(recovered.index.rebuilt, true);
  assert.deepEqual(recovered.results, removed.results);
});
