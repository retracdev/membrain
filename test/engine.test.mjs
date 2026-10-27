import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseConfig } from '../dist/config.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { selectLocations } from '../dist/engine/scopes.js';
import { readStore } from '../dist/storage/store.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'code', 'alpha');
  const b = path.join(directory, 'code', 'beta');
  await mkdir(path.join(a, 'nested', 'deep'), { recursive: true });
  await mkdir(b, { recursive: true });
  const config = parseConfig(
    {
      version: 1,
      global: {
        path: './custom global',
        sync: { mode: 'automatic', authorized: true },
      },
      projects: [
        {
          projectId: 'alpha',
          root: a,
          path: './external alpha',
          sync: { mode: 'manual' },
        },
        { projectId: 'beta', root: b, path: './external beta' },
      ],
      session: { path: './temporary sessions' },
    },
    path.join(directory, 'config.json'),
  );
  const cache = path.join(directory, 'cache');
  const engine = new MemoryEngine(
    config,
    path.join(a, 'nested', 'deep'),
    cache,
  );
  return {
    directory,
    a,
    b,
    config,
    cache,
    engine,
    other: new MemoryEngine(config, b, cache),
    outside: new MemoryEngine(config, directory, cache),
  };
}
const query = (engine, selection = {}, options = {}) =>
  engine.query(selection, { limit: 100, ...options });

test('CRUD preserves identity, history, types, metadata, CAS and tombstones', async (t) => {
  const { engine } = await fixture(t);
  const saved = await engine.remember(
    {},
    {
      content: 'Use SQLite for lexical memory',
      type: 'decision',
      tags: ['storage'],
      sourceAgent: 'test-agent',
      metadata: { rationale: 'offline' },
    },
  );
  assert.equal(saved.warnings.length, 0);
  const record = saved.record;
  assert.equal(record.scope, 'project');
  assert.equal(record.projectId, 'alpha');
  const updated = await engine.update({}, record.id, {
    content: 'Use SQLite with FTS5 and BM25',
    expectedRevision: record.revisionId,
    tags: ['sqlite', 'search'],
    operationId: 'update-once',
  });
  assert.equal(updated.record.id, record.id);
  assert.equal(updated.record.createdAt, record.createdAt);
  assert.ok(updated.record.updatedAt > record.updatedAt);
  assert.deepEqual(updated.record.parentRevisionIds, [record.revisionId]);
  assert.deepEqual(updated.record.metadata, { rationale: 'offline' });
  assert.equal(
    (
      await engine.update({}, record.id, {
        content: 'Use SQLite with FTS5 and BM25',
        expectedRevision: record.revisionId,
        tags: ['sqlite', 'search'],
        operationId: 'update-once',
      })
    ).replayed,
    true,
  );
  await assert.rejects(
    engine.update({}, record.id, {
      content: 'stale',
      expectedRevision: record.revisionId,
    }),
    { code: 'STALE_REVISION' },
  );
  assert.equal(
    (await query(engine, {}, { query: 'lexical' })).results.length,
    0,
  );
  assert.equal(
    (await query(engine, {}, { query: 'BM25' })).results[0].record.id,
    record.id,
  );
  await engine.update({}, record.id, { status: 'superseded' });
  assert.equal(
    (await query(engine, {}, { query: 'sqlite' })).results.length,
    0,
  );
  assert.equal(
    (await query(engine, {}, { state: 'superseded' })).results.length,
    1,
  );
  const deleted = await engine.forget({}, record.id, {
    operationId: 'forget-once',
  });
  assert.equal(deleted.record.status, 'deleted');
  assert.equal(
    (await engine.forget({}, record.id, { operationId: 'forget-once' }))
      .replayed,
    true,
  );
  assert.equal((await query(engine)).results.length, 0);
  const history = await query(engine, {}, { history: true, state: 'all' });
  assert.equal(history.results.length, 4);
  assert.equal(history.results.filter((item) => item.historical).length, 3);
  await assert.rejects(engine.update({}, record.id, { status: 'active' }), {
    code: 'DELETED_MEMORY',
  });
  assert.equal((await query(engine, {}, { rebuild: true })).results.length, 0);
});

test('global, projects and explicit sessions stay isolated at custom paths', async (t) => {
  const { engine, other, outside, config, a } = await fixture(t);
  await engine.remember(
    { scope: 'global' },
    { content: 'shared global preference' },
  );
  await engine.remember({}, { content: 'alpha project knowledge' });
  await other.remember({}, { content: 'beta project knowledge' });
  await engine.remember(
    { scope: 'session', session: 's1' },
    { content: 'alpha temporary task' },
  );
  await engine.remember(
    { scope: 'session', session: 's2' },
    { content: 'alpha other session' },
  );
  await other.remember(
    { scope: 'session', session: 's1' },
    { content: 'beta temporary task' },
  );
  assert.deepEqual(
    new Set((await query(engine)).results.map((item) => item.record.scope)),
    new Set(['global', 'project']),
  );
  assert.equal((await query(engine, { session: 's1' })).results.length, 3);
  assert.equal(
    (await query(engine, { scope: 'session', session: 's1' })).results[0].record
      .content,
    'alpha temporary task',
  );
  assert.equal(
    (await query(other, { scope: 'session', session: 's1' })).results[0].record
      .content,
    'beta temporary task',
  );
  assert.equal((await query(outside)).results.length, 1);
  await assert.rejects(outside.remember({}, { content: 'ambiguous write' }), {
    code: 'SCOPE_REQUIRED',
  });
  await assert.rejects(
    engine.remember({ scope: 'session' }, { content: 'missing session' }),
    { code: 'SESSION_REQUIRED' },
  );
  assert.equal(
    (await query(outside, { scope: 'project', project: 'beta' })).results[0]
      .record.projectId,
    'beta',
  );
  assert.equal(
    (await query(engine, { scope: 'project', allProjects: true })).results
      .length,
    2,
  );
  await mkdir(path.join(a, 'nested', '.git'));
  assert.equal(
    (await selectLocations(config, {}, path.join(a, 'nested', 'deep'))).some(
      (item) => item.scope === 'project',
    ),
    false,
  );
  assert.equal(
    (
      await selectLocations(
        config,
        { project: 'alpha' },
        path.join(a, 'nested', 'deep'),
      )
    ).some((item) => item.scope === 'project'),
    true,
  );
});

test('project markers reassociate clones, non-Git paths resolve and lookalike prefixes do not match', async (t) => {
  const { config, directory, a } = await fixture(t);
  const clone = path.join(directory, 'clone');
  await mkdir(path.join(clone, '.membrain'), { recursive: true });
  await writeFile(
    path.join(clone, '.membrain', 'project.json'),
    JSON.stringify({ schemaVersion: 1, projectId: 'alpha' }),
  );
  assert.equal(
    (await selectLocations(config, {}, clone)).find(
      (item) => item.scope === 'project',
    ).projectId,
    'alpha',
  );
  const lookalike = `${a}-other`;
  await mkdir(lookalike);
  assert.equal(
    (await selectLocations(config, {}, lookalike)).some(
      (item) => item.scope === 'project',
    ),
    false,
  );
});

test('session promotion is explicit and retry-safe, discard is limited to its session', async (t) => {
  const { engine } = await fixture(t);
  const saved = await engine.remember(
    { scope: 'session', session: 'work' },
    { content: 'temporary verified finding' },
  );
  await engine.remember(
    { scope: 'session', session: 'other' },
    { content: 'unrelated temporary finding' },
  );
  assert.equal((await query(engine)).results.length, 0);
  const promoted = await engine.promote(
    { session: 'work' },
    saved.record.id,
    'project',
  );
  assert.notEqual(promoted.record.id, saved.record.id);
  assert.equal(promoted.record.origin.id, saved.record.id);
  assert.equal(
    (await engine.promote({ session: 'work' }, saved.record.id, 'project'))
      .record.id,
    promoted.record.id,
  );
  assert.equal(
    (await query(engine, { scope: 'session', session: 'work' })).results.length,
    1,
  );
  assert.equal(
    (await engine.discardSession({ scope: 'session', session: 'work' })).records
      .length,
    1,
  );
  assert.equal(
    (await engine.discardSession({ scope: 'session', session: 'work' })).records
      .length,
    0,
  );
  assert.equal(
    (await query(engine, { scope: 'session', session: 'other' })).results
      .length,
    1,
  );
  assert.equal((await query(engine)).results.length, 1);
});

test('identical facts and operation retries avoid duplicates; conflicting retries fail', async (t) => {
  const { engine } = await fixture(t);
  const a = await engine.remember(
    {},
    { content: 'stable fact', tags: ['a', 'b'], sourceAgent: 'agent-a' },
  );
  const b = await engine.remember(
    {},
    {
      content: 'stable fact',
      tags: ['b', 'a'],
      sourceAgent: 'agent-b',
      operationId: 'create-once',
    },
  );
  assert.equal(b.deduplicated, true);
  assert.equal(a.record.id, b.record.id);
  assert.equal(
    (
      await engine.remember(
        {},
        {
          content: 'stable fact',
          tags: ['a', 'b'],
          operationId: 'create-once',
        },
      )
    ).replayed,
    true,
  );
  await assert.rejects(
    engine.remember(
      {},
      { content: 'different fact', operationId: 'create-once' },
    ),
    { code: 'OPERATION_CONFLICT' },
  );
  await engine.forget({}, a.record.id);
  const retry = await engine.remember(
    {},
    { content: 'stable fact', tags: ['a', 'b'], operationId: 'create-once' },
  );
  assert.equal(retry.record.status, 'deleted');
  assert.equal((await query(engine)).results.length, 0);
});

test('search uses deterministic BM25 with Unicode, literal syntax, tags and limits', async (t) => {
  const { engine } = await fixture(t);
  const strong = await engine.remember(
    {},
    { content: 'sqlite sqlite sqlite', tags: ['database'] },
  );
  await engine.remember(
    {},
    {
      content:
        'sqlite project architecture development local memory reliability',
      tags: ['architecture'],
    },
  );
  await engine.remember(
    {},
    { content: 'Café données 日本語 searchable notes', tags: ['unicode'] },
  );
  const result = await query(engine, {}, { query: 'SQLITE' });
  assert.equal(result.results[0].record.id, strong.record.id);
  assert.ok(result.results[0].score < result.results[1].score);
  assert.equal(
    (
      await query(
        engine,
        {},
        { query: '"sqlite" OR "unmatched"', tags: ['database'] },
      )
    ).results.length,
    1,
  );
  assert.equal((await query(engine, {}, { query: 'cafe' })).results.length, 1);
  assert.equal(
    (await query(engine, {}, { query: '日本語' })).results.length,
    1,
  );
  assert.equal(
    (await query(engine, {}, { query: 'sqlite', limit: 1 })).results.length,
    1,
  );
  assert.equal(
    (await query(engine, {}, { query: 'nomatch' })).results.length,
    0,
  );
  const secondPage = await query(
    engine,
    {},
    { query: 'sqlite', limit: 1, offset: 1 },
  );
  assert.notEqual(secondPage.results[0].record.id, strong.record.id);
  for (const value of ['', '   ', '* : () "'])
    await assert.rejects(query(engine, {}, { query: value }), {
      code: 'INVALID_QUERY',
    });
  await assert.rejects(query(engine, {}, { limit: 101 }), {
    code: 'INVALID_LIMIT',
  });
  const original = result.results.map((item) => [item.record.id, item.score]);
  assert.deepEqual(
    (await query(engine, {}, { query: 'sqlite', rebuild: true })).results.map(
      (item) => [item.record.id, item.score],
    ),
    original,
  );
});

test('equal BM25 scores use stable binary memory-ID ordering', async (t) => {
  const { engine } = await fixture(t);
  await engine.remember(
    {},
    { content: 'equal ranking words', metadata: { sample: 1 } },
  );
  await engine.remember(
    {},
    { content: 'equal ranking words', metadata: { sample: 2 } },
  );
  const data = await query(engine, {}, { query: 'equal' });
  assert.equal(data.results[0].score, data.results[1].score);
  const ids = data.results.map((item) => item.record.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('missing/damaged indexes recover; invalid JSONL is preserved and blocks stale recall', async (t) => {
  const { engine, config } = await fixture(t);
  const saved = await engine.remember(
    {},
    { content: 'rebuild this durable memory' },
  );
  let result = await query(engine, {}, { query: 'durable' });
  await rm(result.index.path);
  result = await query(engine, {}, { query: 'durable' });
  assert.equal(result.index.rebuilt, true);
  await writeFile(result.index.path, 'not sqlite');
  result = await query(engine, {}, { query: 'durable' });
  assert.equal(result.warnings[0].code, 'INDEX_RECOVERED');
  const source = path.join(
    config.projects[0].path,
    'records',
    saved.record.id,
    `${saved.record.revisionId}.jsonl`,
  );
  await writeFile(source, '{"partial":');
  await assert.rejects(query(engine, {}, { query: 'durable', rebuild: true }), {
    code: 'CORRUPT_STORE',
  });
  assert.equal(await readFile(source, 'utf8'), '{"partial":');
});

test('Git-style LF/CRLF conversion preserves portable records and index fingerprints', async (t) => {
  const { engine, config } = await fixture(t);
  const saved = await engine.remember(
    {},
    { content: 'portable newline memory' },
  );
  const filename = path.join(
    config.projects[0].path,
    'records',
    saved.record.id,
    `${saved.record.revisionId}.jsonl`,
  );
  const original = await readFile(filename, 'utf8');
  await writeFile(filename, `${original.slice(0, -1)}\r\n`);
  const data = await query(engine, { scope: 'project' }, { query: 'portable' });
  assert.equal(data.results[0].record.id, saved.record.id);
  assert.equal(data.index.rebuilt, false);
});

test('valid but modified immutable revisions are detected against the local manifest', async (t) => {
  const { engine, config } = await fixture(t);
  const saved = await engine.remember({}, { content: 'immutable source' });
  const source = path.join(
    config.projects[0].path,
    'records',
    saved.record.id,
    `${saved.record.revisionId}.jsonl`,
  );
  await writeFile(
    source,
    `${JSON.stringify({ ...saved.record, content: 'rewritten immutable source' })}\n`,
  );
  await assert.rejects(query(engine, { scope: 'project' }), {
    code: 'CORRUPT_STORE',
  });
});

test('competing imported heads never choose a timestamp winner or resurrect deletions', async (t) => {
  const { engine, config } = await fixture(t);
  const saved = await engine.remember({}, { content: 'conflict baseline' });
  const timestamp = new Date(
    Date.parse(saved.record.updatedAt) + 10,
  ).toISOString();
  for (const status of ['active', 'deleted']) {
    const record = {
      ...saved.record,
      revisionId: randomUUID(),
      parentRevisionIds: [saved.record.revisionId],
      updatedAt: timestamp,
      content: 'competing branch',
      status,
    };
    await writeFile(
      path.join(
        config.projects[0].path,
        'records',
        record.id,
        `${record.revisionId}.jsonl`,
      ),
      `${JSON.stringify(record)}\n`,
    );
  }
  assert.equal(
    (await query(engine, {}, { query: 'competing' })).results.length,
    0,
  );
  const list = await query(engine, {}, { state: 'all' });
  assert.equal(list.results.length, 2);
  assert.ok(list.results.every((item) => item.conflict));
  await assert.rejects(
    engine.update({}, saved.record.id, { content: 'guess a winner' }),
    { code: 'REVISION_CONFLICT' },
  );
});

test('secret patterns and invalid records fail before creating source files', async (t) => {
  const { engine, config } = await fixture(t);
  await assert.rejects(
    engine.remember(
      {},
      { content: 'safe content', operationId: `ghp_${'x'.repeat(30)}` },
    ),
    { code: 'SECRET_DETECTED' },
  );
  await assert.rejects(
    engine.remember(
      { scope: 'session', session: `ghp_${'x'.repeat(30)}` },
      { content: 'safe content' },
    ),
    { code: 'SECRET_DETECTED' },
  );
  for (const content of [
    '-----BEGIN PRIVATE KEY----- synthetic',
    `ghp_${'x'.repeat(30)}`,
    'api_key=syntheticCredential12345',
  ]) {
    await assert.rejects(engine.remember({}, { content }), {
      code: 'SECRET_DETECTED',
    });
  }
  await assert.rejects(
    engine.remember(
      {},
      { content: 'fine', metadata: { password: 'syntheticPassword123' } },
    ),
    { code: 'SECRET_DETECTED' },
  );
  await assert.rejects(engine.remember({}, { content: '' }), {
    code: 'INVALID_RECORD',
  });
  await assert.rejects(engine.remember({}, { content: 'a'.repeat(65_537) }), {
    code: 'INVALID_RECORD',
  });
  await assert.rejects(readdir(config.projects[0].path), { code: 'ENOENT' });
});

test('index failure after a durable save reports success and a pending warning', async (t) => {
  const { engine, config, a, directory } = await fixture(t);
  const blocked = path.join(directory, 'blocked-cache');
  await writeFile(blocked, 'not a directory');
  const broken = new MemoryEngine(config, a, blocked);
  const saved = await broken.remember(
    {},
    { content: 'durable even without index', operationId: 'safe-retry' },
  );
  assert.equal(saved.warnings[0].code, 'INDEX_PENDING');
  assert.equal((await query(engine)).results[0].record.id, saved.record.id);
  assert.equal(
    (
      await engine.remember(
        {},
        { content: 'durable even without index', operationId: 'safe-retry' },
      )
    ).record.id,
    saved.record.id,
  );
});

test('overlapping and aliased roots are rejected; source symlinks cannot escape', async (t) => {
  const { config, engine, a, directory } = await fixture(t);
  const overlap = { ...config, global: { ...config.global } };
  overlap.global.path = overlap.projects[0].path;
  await assert.rejects(
    new MemoryEngine(overlap, a).remember({}, { content: 'unsafe overlap' }),
    { code: 'OVERLAPPING_STORES' },
  );
  const saved = await engine.remember({}, { content: 'symlink protection' });
  const target = path.join(directory, 'elsewhere');
  await mkdir(target);
  const alias = path.join(config.projects[0].path, 'records', randomUUID());
  await symlink(
    target,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(query(engine), { code: 'CORRUPT_STORE' });
  assert.equal(saved.record.status, 'active');
});

test('source manifest mismatch, invalid UTF-8 and incomplete revisions fail safely', async (t) => {
  const { engine, config } = await fixture(t);
  const saved = await engine.remember({}, { content: 'source validation' });
  const [location] = await selectLocations(
    config,
    { scope: 'project' },
    config.projects[0].root,
  );
  const filename = path.join(
    location.path,
    'records',
    saved.record.id,
    `${saved.record.revisionId}.jsonl`,
  );
  for (const bytes of [
    Buffer.from(JSON.stringify(saved.record)),
    Buffer.from([0xff, 0x0a]),
  ]) {
    await writeFile(filename, bytes);
    await assert.rejects(readStore(location), { code: 'CORRUPT_STORE' });
  }
  await writeFile(filename, `${JSON.stringify(saved.record)}\n`);
  const manifestFile = path.join(location.path, 'store.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  await writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, projectId: 'wrong-project' }),
  );
  await assert.rejects(readStore(location), { code: 'CORRUPT_STORE' });
});
