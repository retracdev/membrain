import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { populateFixture } from '../fixtures/performance-store.mjs';
import { manifestPath } from '../dist/index/generation.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function fixture(t, count = 12) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'membrain-incremental-'),
  );
  assert.equal(path.dirname(directory), os.tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const filename = path.join(directory, 'config.json');
  const value = { version: 1, global: { path: './source' } };
  await writeFile(filename, JSON.stringify(value));
  const config = parseConfig(value, filename);
  const records = await populateFixture(config, directory, count, [
    { scope: 'global' },
  ]);
  const cache = path.join(directory, 'cache');
  const engine = new MemoryEngine(config, directory, cache);
  const query = (options = {}) =>
    engine.query(
      { scope: 'global' },
      { limit: 5, query: 'SQLite', verification: 'fast', ...options },
    );
  const initial = await query();
  const publish = async (record) => {
    const folder = path.join(config.global.path, 'records', record.id);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${record.revisionId}.jsonl`);
    await writeFile(file, `${JSON.stringify(record)}\n`);
    return file;
  };
  return {
    directory,
    filename,
    config,
    records,
    cache,
    engine,
    query,
    initial,
    publish,
  };
}
function next(previous, patch = {}) {
  return {
    ...previous,
    revisionId: randomUUID(),
    parentRevisionIds: [previous.revisionId],
    updatedAt: new Date(Date.parse(previous.updatedAt) + 1).toISOString(),
    ...patch,
  };
}
function run(f, ...args) {
  return spawnSync(
    process.execPath,
    [cli, '--config', f.filename, '--json', ...args, '--scope', 'global'],
    {
      cwd: f.directory,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PATH: '',
        MEMBRAIN_CACHE_DIR: f.cache,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

for (const count of [12, 1000])
  test(`fast verification reads returned bytes and new revisions, not ${count * 2} historical files`, async (t) => {
    const f = await fixture(t, count);
    const events = [];
    const listener = (event) => events.push(event);
    subscribe('membrain.performance', listener);
    try {
      const warm = await f.query({ readOnly: true });
      assert.deepEqual(warm.results, f.initial.results);
      assert.equal(warm.index.rebuilt, false);
      assert.equal(
        events.some(({ name }) => name === 'store.projection'),
        false,
      );
      assert.equal(
        events.filter(({ name }) => name === 'store.validationCpu').length,
        warm.results.length,
      );
      events.length = 0;
      const added = next(f.records[0].current, {
        content: 'SQLite incremental visibility',
      });
      await f.publish(added);
      const changed = await f.query();
      assert.equal(changed.index.rebuilt, false);
      assert.equal(changed.index.updated, true);
      assert.equal(changed.index.revisions, count * 2 + 1);
      assert.equal(
        events.filter(({ name }) => name === 'store.validationCpu').length,
        changed.results.length + 1,
      );
      const strict = await f.query({ verification: 'strict' });
      assert.deepEqual(changed.results, strict.results);
      assert.equal(strict.index.rebuilt, false);
    } finally {
      unsubscribe('membrain.performance', listener);
    }
  });

test('external tombstones, timestamp anomalies, supersession and missing history never resurrect memories', async (t) => {
  const f = await fixture(t);
  const selected = f.initial.results[0].record;
  const folder = path.join(f.config.global.path, 'records', selected.id);
  const stamp = await lstat(folder);
  const tombstone = next(selected, { status: 'deleted' });
  const file = await f.publish(tombstone);
  await utimes(folder, stamp.atime, stamp.mtime);
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  const changed = await f.query();
  assert.equal(changed.index.updated, true);
  assert.ok(changed.results.every(({ record }) => record.id !== selected.id));
  const superseded = next(
    f.records.find(({ current }) => current.id !== selected.id).current,
    { status: 'superseded' },
  );
  await f.publish(superseded);
  assert.ok(
    (await f.query()).results.every(
      ({ record }) => record.id !== superseded.id,
    ),
  );
  await rm(file);
  for (const verification of ['fast', 'strict'])
    await assert.rejects(f.query({ verification }), { code: 'CORRUPT_STORE' });
});

test('missing and damaged generation manifests require full validation without stale read-only fallback', async (t) => {
  const f = await fixture(t);
  const marker = manifestPath(f.initial.index.path);
  await rm(marker);
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.equal((await f.query()).index.rebuilt, true);
  await writeFile(marker, '{"version":1,"sha256":"incomplete"}');
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  const recovered = await f.query();
  assert.deepEqual(recovered.results, f.initial.results);
  assert.ok(recovered.warnings.some(({ code }) => code === 'INDEX_RECOVERED'));
});

test('same-size restored-time edits expose the explicit fast/strict boundary without returning changed bytes', async (t) => {
  const f = await fixture(t);
  const historical = f.records[0].base;
  const source = path.join(
    f.config.global.path,
    'records',
    historical.id,
    `${historical.revisionId}.jsonl`,
  );
  const original = await readFile(source, 'utf8');
  const stamp = await lstat(source);
  await writeFile(source, original.replace('Historical', 'Rewritten!'));
  await utimes(source, stamp.atime, stamp.mtime);
  assert.equal((await lstat(source)).size, Buffer.byteLength(original));
  assert.equal((await f.query()).index.rebuilt, false); // Unreturned ancestor is explicitly outside fast byte verification.
  await assert.rejects(f.query({ verification: 'strict' }), {
    code: 'CORRUPT_STORE',
  });
  await assert.rejects(f.query({ rebuild: true }), { code: 'CORRUPT_STORE' });
  await writeFile(source, original);
  const current = f.initial.results[0].record;
  const currentFile = path.join(
    f.config.global.path,
    'records',
    current.id,
    `${current.revisionId}.jsonl`,
  );
  const text = await readFile(currentFile, 'utf8');
  const currentStamp = await lstat(currentFile);
  await writeFile(currentFile, text.replace('current', 'changed'));
  await utimes(currentFile, currentStamp.atime, currentStamp.mtime);
  await assert.rejects(f.query(), { code: 'CORRUPT_STORE' });
  const result = run(f, 'recall', 'SQLite');
  assert.notEqual(result.status, 0); // CLI compatibility default remains strict.
  assert.equal(JSON.parse(result.stderr).error.code, 'CORRUPT_STORE');
});

test('missing, corrupt, incompatible and copied indexes recover through authoritative validation', async (t) => {
  const f = await fixture(t);
  await writeFile(f.initial.index.path, 'broken disposable SQLite');
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.deepEqual((await f.query()).results, f.initial.results);
  let db = new Database(f.initial.index.path);
  db.prepare(
    "UPDATE settings SET value='another-filesystem' WHERE key='checkpoint'",
  ).run();
  db.close();
  assert.deepEqual((await f.query()).results, f.initial.results);
  db = new Database(f.initial.index.path);
  const checkpoints = JSON.parse(
    db
      .prepare("SELECT value FROM settings WHERE key='checkpoint'")
      .pluck()
      .get(),
  );
  for (const checkpoint of checkpoints)
    checkpoint.binding = 'copied-from-another-machine';
  db.prepare("UPDATE settings SET value=? WHERE key='checkpoint'").run(
    JSON.stringify(checkpoints),
  );
  db.close();
  const historical = f.records[0].base;
  const source = path.join(
    f.config.global.path,
    'records',
    historical.id,
    `${historical.revisionId}.jsonl`,
  );
  const original = await readFile(source, 'utf8');
  await writeFile(source, original.replace('Historical', 'Rewritten!'));
  await assert.rejects(f.query(), { code: 'CORRUPT_STORE' });
  await writeFile(source, original);
  await rm(f.cache, { recursive: true });
  assert.equal((await f.query()).index.rebuilt, true);
});

test('partial private generations and malformed new revisions preserve the published index', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.initial.index.path);
  const partial = path.join(
    path.dirname(f.initial.index.path),
    `${randomUUID()}.sqlite`,
  );
  await writeFile(partial, 'interrupted unpublished generation');
  await writeFile(`${partial}-journal`, 'interrupted private rollback journal');
  assert.deepEqual((await f.query()).results, f.initial.results);
  const invalid = path.join(
    f.config.global.path,
    'records',
    f.records[0].current.id,
    `${randomUUID()}.jsonl`,
  );
  await writeFile(invalid, '{"incomplete":');
  await assert.rejects(f.query(), { code: 'CORRUPT_STORE' });
  assert.deepEqual(await readFile(f.initial.index.path), before);
  await rm(invalid);
  const temporary = path.join(
    f.config.global.path,
    'records',
    f.records[0].current.id,
    '.interrupted.membrain-tmp',
  );
  await writeFile(temporary, 'not published');
  assert.ok(
    (await f.query()).warnings.some(({ code }) => code === 'UNPUBLISHED_FILE'),
  );
  assert.deepEqual(await readFile(f.initial.index.path), before);
});

test('cross-process creates, updates, deletes and read-only offline fast CLI retrieval stay current', async (t) => {
  const f = await fixture(t);
  let result = run(f, 'remember', 'SQLite crossprocess decision');
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout).record;
  assert.ok(
    (await f.query({ query: 'crossprocess' })).results.some(
      ({ record }) => record.id === saved.id,
    ),
  );
  result = run(f, 'update', saved.id, 'SQLite crossprocess updated');
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    (await f.query({ query: 'crossprocess' })).results[0].record.content,
    /updated/u,
  );
  result = run(f, 'forget', saved.id, '--yes');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await f.query({ query: 'crossprocess' })).results.length, 0);
  result = spawnSync(
    process.execPath,
    [
      '--permission',
      '--allow-addons',
      '--allow-fs-read=*',
      cli,
      '--config',
      f.filename,
      '--json',
      'recall',
      'SQLite',
      '--verification',
      'fast',
      '--read-only',
    ],
    {
      cwd: f.directory,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PATH: '',
        MEMBRAIN_CACHE_DIR: f.cache,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).index.verification, 'fast');
});

test('store replacement forces validation even when a copied index has identical paths', async (t) => {
  const f = await fixture(t);
  const replacement = path.join(f.directory, 'replacement');
  await cp(f.config.global.path, replacement, { recursive: true });
  await rm(f.config.global.path, { recursive: true });
  await cp(replacement, f.config.global.path, { recursive: true });
  const events = [];
  const listener = (event) => events.push(event);
  subscribe('membrain.performance', listener);
  try {
    assert.deepEqual((await f.query()).results, f.initial.results);
    assert.ok(
      events.filter(({ name }) => name === 'store.validationCpu').length >= 24,
    );
    events.length = 0;
    await f.query();
    assert.equal(
      events.filter(({ name }) => name === 'store.validationCpu').length,
      5,
    );
  } finally {
    unsubscribe('membrain.performance', listener);
  }
});

test('writer projection retains full verified history and reports edited ancestors', async (t) => {
  const f = await fixture(t);
  const { base, current } = f.records[0];
  const source = path.join(
    f.config.global.path,
    'records',
    base.id,
    `${base.revisionId}.jsonl`,
  );
  const original = await readFile(source, 'utf8');
  await writeFile(source, original.replace('Historical', 'Rewritten!'));
  const saved = await f.engine.update({ scope: 'global' }, current.id, {
    content: 'SQLite explicit new revision',
  });
  assert.ok(saved.warnings.some(({ code }) => code === 'INDEX_PENDING'));
  await assert.rejects(f.query({ verification: 'strict' }), {
    code: 'CORRUPT_STORE',
  });
});

test('fast removal of entire memories and imported conflicting heads match a strict rebuild', async (t) => {
  const f = await fixture(t);
  const removed = f.initial.results[0].record;
  await rm(path.join(f.config.global.path, 'records', removed.id), {
    recursive: true,
  });
  const candidate = f.records.find(
    ({ current }) => current.id !== removed.id,
  ).current;
  await f.publish(
    next(candidate, { content: 'SQLite imported competing update' }),
  );
  await f.publish(next(candidate, { status: 'deleted' }));
  const changed = await f.query({ limit: 100 });
  assert.equal(changed.index.updated, true);
  assert.ok(
    changed.results.every(
      ({ record }) => record.id !== removed.id && record.id !== candidate.id,
    ),
  );
  const rebuilt = await f.query({
    verification: 'strict',
    rebuild: true,
    limit: 100,
  });
  assert.deepEqual(changed.results, rebuilt.results);
  const conflict = await f.engine.query(
    { scope: 'global' },
    { limit: 100, state: 'all', verification: 'fast' },
  );
  assert.equal(
    conflict.results.filter(
      ({ record, conflict }) => record.id === candidate.id && conflict,
    ).length,
    2,
  );
});

test('fast returned CRLF revisions retain integrity and logical checkpoint damage recovers', async (t) => {
  const f = await fixture(t);
  const selected = f.initial.results[0].record;
  const source = path.join(
    f.config.global.path,
    'records',
    selected.id,
    `${selected.revisionId}.jsonl`,
  );
  const original = await readFile(source, 'utf8');
  await writeFile(source, original.replace(/\n$/u, '\r\n'));
  assert.deepEqual((await f.query()).results, f.initial.results);
  const db = new Database(f.initial.index.path);
  const metadata = JSON.parse(
    db
      .prepare("SELECT value FROM settings WHERE key='checkpoint'")
      .pluck()
      .get(),
  );
  metadata[0].unknownVersionField = true;
  db.prepare("UPDATE settings SET value=? WHERE key='checkpoint'").run(
    JSON.stringify(metadata),
  );
  db.close();
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.equal((await f.query()).index.rebuilt, true);
  const changed = new Database(f.initial.index.path);
  const row = changed.prepare('SELECT key,record FROM hashes LIMIT 1').get();
  const record = JSON.parse(row.record);
  record.content = 'SQLite logically damaged cached content';
  changed
    .prepare('UPDATE hashes SET record=? WHERE key=?')
    .run(JSON.stringify(record), row.key);
  changed.close();
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.deepEqual((await f.query()).results, f.initial.results);
});

for (const checkpoint of ['index', 'manifest'])
  test(
    `killing incremental maintenance before ${checkpoint} publication recovers a tombstone`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      const before = await readFile(f.initial.index.path);
      const deleted = f.initial.results[0].record;
      await f.publish(next(deleted, { status: 'deleted' }));
      const crasher = fileURLToPath(
        new URL('../fixtures/index-crash.mjs', import.meta.url),
      );
      const child = spawn(
        process.execPath,
        [crasher, f.filename, f.cache, checkpoint],
        {
          cwd: f.directory,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (part) => {
        stderr += part;
      });
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      const exited = once(child, 'exit');
      const reached = await Promise.race([
        once(child, 'message'),
        exited.then(() => {
          throw new Error(`Crash fixture exited early: ${stderr}`);
        }),
      ]);
      assert.equal(reached[0].stage, `before-${checkpoint}-publication`);
      child.kill('SIGKILL');
      await exited;
      if (checkpoint === 'index')
        assert.deepEqual(await readFile(f.initial.index.path), before);
      else {
        const published = new Database(f.initial.index.path, {
          readonly: true,
        });
        assert.equal(
          published.pragma('integrity_check', { simple: true }),
          'ok',
        );
        published.close();
        await assert.rejects(f.query({ readOnly: true }), {
          code: 'INDEX_READ_ONLY',
        });
      }
      const lock = path.join(
        path.dirname(f.initial.index.path),
        '.membrain-lock',
      );
      const owner = JSON.parse(
        await readFile(path.join(lock, 'owner.json'), 'utf8'),
      );
      assert.equal(owner.pid, child.pid);
      await rm(lock, { recursive: true }); // Only this known dead fixture owner is recovered.
      const recovered = await f.query();
      if (checkpoint === 'index') assert.equal(recovered.index.updated, true);
      else assert.equal(recovered.index.rebuilt, true);
      assert.ok(
        recovered.results.every(({ record }) => record.id !== deleted.id),
      );
    },
  );

test('fast corpora isolate global/project/session memory and explicit promotion', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.directory, 'project');
  await mkdir(root);
  const config = parseConfig(
    {
      version: 1,
      global: { path: f.config.global.path },
      projects: [{ projectId: 'alpha', root, path: './project-store' }],
      session: { path: './sessions' },
    },
    f.filename,
  );
  const engine = new MemoryEngine(config, root, f.cache);
  const local = await engine.remember(
    { scope: 'project' },
    { content: 'SQLite project-only decision' },
  );
  const session = await engine.remember(
    { scope: 'session', session: 'work' },
    { content: 'SQLite selected-session decision' },
  );
  const hidden = await engine.remember(
    { scope: 'session', session: 'hidden' },
    { content: 'SQLite hidden-session decision' },
  );
  for (let i = 0; i < 2; i++)
    await engine.remember(
      { scope: 'session', session: 'work' },
      { content: `SQLite selected-session additional ${i}` },
    );
  const query = (selection = {}) =>
    engine.query(selection, {
      query: 'SQLite',
      limit: 100,
      verification: 'fast',
    });
  assert.ok(
    (await query()).results.some(({ record }) => record.id === local.record.id),
  );
  assert.ok(
    (await query()).results.every(({ record }) => record.scope !== 'session'),
  );
  const selected = await query({ session: 'work' });
  assert.ok(
    selected.results.some(({ record }) => record.id === session.record.id),
  );
  assert.ok(
    selected.results.every(({ record }) => record.id !== hidden.record.id),
  );
  const promoted = await engine.promote(
    { session: 'work' },
    session.record.id,
    'project',
  );
  assert.ok(
    (await query()).results.some(
      ({ record }) => record.id === promoted.record.id,
    ),
  );
  await engine.forget({ scope: 'project' }, promoted.record.id);
  assert.ok(
    (await query()).results.every(
      ({ record }) => record.id !== promoted.record.id,
    ),
  );
  const global = await query({ scope: 'global' });
  assert.ok(global.results.every(({ record }) => record.scope === 'global'));
  const discarded = await engine.discardSession({ session: 'work' });
  assert.equal(discarded.records.length, 3);
  assert.ok(
    (await query({ session: 'work' })).results.every(
      ({ record }) => record.scope !== 'session',
    ),
  );
});
