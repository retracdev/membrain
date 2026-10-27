import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as closeAfter, clearTimeout } from 'node:timers';
import { MemoryEngine } from '../dist/engine/engine.js';
import { parseConfig } from '../dist/config.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-index-'));
  assert.equal(path.dirname(directory), os.tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const cache = path.join(directory, 'cache');
  const configFile = path.join(directory, 'config.json');
  const value = {
    version: 1,
    global: { path: path.join(directory, 'source') },
  };
  await writeFile(configFile, JSON.stringify(value));
  const config = parseConfig(value, configFile);
  const engine = new MemoryEngine(config, directory, cache);
  const saved = await engine.remember(
    { scope: 'global' },
    { content: 'immutable SQLite decision' },
  );
  assert.deepEqual(saved.warnings, []);
  const query = (options = {}) =>
    engine.query(
      { scope: 'global' },
      { query: 'SQLite', limit: 10, ...options },
    );
  const result = await query();
  return {
    directory,
    cache,
    configFile,
    config,
    engine,
    query,
    saved,
    index: result.index.path,
    source: path.join(
      config.global.path,
      'records',
      saved.record.id,
      `${saved.record.revisionId}.jsonl`,
    ),
  };
}
async function tree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    const file = path.join(entry.parentPath, entry.name);
    const stat = await lstat(file);
    values.push([
      path.relative(root, file),
      stat.mtimeMs,
      stat.isFile() ? (await readFile(file)).toString('base64') : 'directory',
    ]);
  }
  return values.sort(([a], [b]) => a.localeCompare(b));
}

test('unchanged retrieval needs no filesystem write permission or index lock', async (t) => {
  const f = await fixture(t);
  const lock = path.join(path.dirname(f.index), '.membrain-lock');
  await mkdir(lock); // Existing readers do not wait for maintenance locks.
  const before = await tree(f.directory);
  for (const mode of [[], ['--read-only']]) {
    const result = spawnSync(
      process.execPath,
      [
        '--permission',
        '--allow-addons',
        '--allow-fs-read=*',
        cli,
        '--config',
        f.configFile,
        'recall',
        'SQLite',
        '--json',
        ...mode,
      ],
      {
        cwd: f.directory,
        env: { ...process.env, MEMBRAIN_CACHE_DIR: f.cache, NODE_OPTIONS: '' },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.results[0].id, f.saved.record.id);
    assert.equal(data.index.rebuilt, false);
  }
  assert.deepEqual(await tree(f.directory), before);
});

test('read-only refuses absent, stale and damaged indexes without creating or replacing files', async (t) => {
  const f = await fixture(t);
  await rm(f.cache, { recursive: true });
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  await assert.rejects(lstat(f.cache), { code: 'ENOENT' });
  await f.query();
  const external = {
    ...f.saved.record,
    id: randomUUID(),
    revisionId: randomUUID(),
    content: 'Additional SQLite decision',
  };
  const folder = path.join(f.config.global.path, 'records', external.id);
  await mkdir(folder);
  await writeFile(
    path.join(folder, `${external.revisionId}.jsonl`),
    `${JSON.stringify(external)}\n`,
  );
  const before = await tree(f.directory);
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.deepEqual(await tree(f.directory), before);
  const refreshed = await f.query();
  assert.equal(refreshed.index.rebuilt, true);
  assert.equal(refreshed.results.length, 2);
  await writeFile(f.index, 'damaged SQLite fixture');
  const damaged = await readFile(f.index);
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.deepEqual(await readFile(f.index), damaged);
  const recovered = await f.query();
  assert.equal(recovered.results.length, 2);
  assert.ok(recovered.warnings.some((item) => item.code === 'INDEX_RECOVERED'));
  await assert.rejects(f.query({ readOnly: true, rebuild: true }), {
    code: 'INVALID_QUERY',
  });
});

test('deep FTS corruption is checked without writing the cache and recovers from JSONL', async (t) => {
  const f = await fixture(t);
  const db = new Database(f.index);
  try {
    // Deliberately corrupt only this disposable fixture's internal FTS totals.
    db.unsafeMode(true);
    db.exec("UPDATE fts_data SET block=x'00' WHERE id=1");
    assert.equal(db.pragma("quick_check('entries')", { simple: true }), 'ok');
  } finally {
    db.close();
  }
  const damaged = await readFile(f.index);
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  assert.deepEqual(await readFile(f.index), damaged);
  const recovered = await f.query();
  assert.equal(recovered.results[0].record.id, f.saved.record.id);
  assert.ok(recovered.warnings.some((item) => item.code === 'INDEX_RECOVERED'));
});

test('index replacement tolerates another read-only connection holding a generation', async (t) => {
  const f = await fixture(t);
  const reader = new Database(f.index, { readonly: true });
  reader.prepare('SELECT count(*) FROM entries').get();
  const timer = closeAfter(() => {
    if (reader.open) reader.close();
  }, 500);
  try {
    const result = await f.query({ rebuild: true });
    assert.equal(result.index.rebuilt, true);
    assert.equal(result.results[0].record.id, f.saved.record.id);
  } finally {
    clearTimeout(timer);
    if (reader.open) reader.close();
  }
});

test('full hashing detects same-size edits with restored modification time and source removal', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.source, 'utf8');
  const stat = await lstat(f.source);
  await writeFile(f.source, original.replace('immutable', 'rewritten'));
  await utimes(f.source, stat.atime, stat.mtime);
  for (const readOnly of [true, false])
    await assert.rejects(f.query({ readOnly }), { code: 'CORRUPT_STORE' });
  await writeFile(f.source, original);
  await rm(path.dirname(f.source), { recursive: true });
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'INDEX_READ_ONLY',
  });
  const empty = await f.query();
  assert.equal(empty.results.length, 0);
  assert.equal(empty.index.rebuilt, true);
});

test('unavailable index directories report an actionable error and preserve durable records', async (t) => {
  const f = await fixture(t);
  const blocker = path.join(f.directory, 'not-a-directory');
  await writeFile(blocker, 'preserve');
  const engine = new MemoryEngine(f.config, f.directory, blocker);
  await assert.rejects(
    engine.query({ scope: 'global' }, { query: 'SQLite', limit: 5 }),
    (error) => {
      assert.equal(error.code, 'INDEX_UNAVAILABLE');
      assert.match(error.message, /MEMBRAIN_CACHE_DIR/u);
      assert.match(error.message, /permissions/u);
      return true;
    },
  );
  assert.equal(await readFile(blocker, 'utf8'), 'preserve');
  assert.equal(
    JSON.parse(await readFile(f.source, 'utf8')).revisionId,
    f.saved.record.revisionId,
  );
});

test(
  'read-only cache permissions allow reuse and prevent maintenance on POSIX',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    const directory = path.dirname(f.index);
    try {
      await chmod(f.index, 0o400);
      await chmod(directory, 0o500);
      await chmod(f.cache, 0o500);
      assert.equal((await f.query()).index.rebuilt, false);
      assert.equal((await f.query({ readOnly: true })).results.length, 1);
      await assert.rejects(f.query({ rebuild: true }), {
        code: 'INDEX_UNAVAILABLE',
      });
    } finally {
      await chmod(f.cache, 0o700);
      await chmod(directory, 0o700);
      await chmod(f.index, 0o600);
    }
  },
);

test('symlinked cache generation directories are refused', async (t) => {
  const f = await fixture(t);
  const generation = path.dirname(f.index);
  const target = path.join(f.directory, 'other-cache');
  await mkdir(target);
  await rm(generation, { recursive: true });
  await symlink(
    target,
    generation,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(f.query({ readOnly: true }), {
    code: 'UNSAFE_CACHE_PATH',
  });
  assert.deepEqual(await readdir(target), []);
});

test(
  'Windows ACL denies cache maintenance while allowing current-index retrieval',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    const identity = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(identity.status, 0, identity.stderr);
    const sid = identity.stdout.match(/S-1-[\d-]+/u)?.[0];
    assert.ok(sid, 'Expected current user SID');
    const directory = path.dirname(f.index);
    const acl = (...args) => {
      const result = spawnSync('icacls', [directory, ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      acl('/deny', `*${sid}:(WD,AD)`);
      assert.equal((await f.query()).index.rebuilt, false);
      assert.equal((await f.query({ readOnly: true })).results.length, 1);
      await assert.rejects(f.query({ rebuild: true }), {
        code: 'INDEX_UNAVAILABLE',
      });
    } finally {
      acl('/remove:d', `*${sid}`);
    }
  },
);
