import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  readdir,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Git } from '../dist/sync/git.js';
import { MembrainError } from '../dist/errors.js';
import { MemoryEngine } from '../dist/engine/engine.js';
import { synchronizeMemories } from '../dist/sync/sync.js';
import {
  appendRevision,
  writeStore,
  readStore,
} from '../dist/storage/store.js';

// Isolate Git identity/hooks/credential configuration from the developer machine.
process.env.GIT_CONFIG_GLOBAL =
  process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
async function initialize(root, bare = false) {
  await mkdir(root, { recursive: true });
  git(root, 'init', ...(bare ? ['--bare'] : []), '--initial-branch=main');
  if (!bare) {
    git(root, 'config', 'user.name', 'Membrain Test');
    git(root, 'config', 'user.email', 'membrain-test@example.invalid');
    git(root, 'config', 'core.autocrlf', 'false');
  }
}
async function fixture(t, { seed = true } = {}) {
  const temporary = await realpath(os.tmpdir());
  const directory = await realpath(
    await mkdtemp(path.join(temporary, 'membrain-sync-')),
  );
  assert.equal(path.dirname(directory), temporary);
  assert.ok(path.basename(directory).startsWith('membrain-sync-'));
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const remote = path.join(directory, 'remote.git');
  const a = path.join(directory, 'work a');
  const b = path.join(directory, 'work b');
  await initialize(remote, true);
  await initialize(a);
  await writeFile(path.join(a, 'owner.txt'), 'Unrelated clean owner file\n');
  git(a, 'add', '--', 'owner.txt');
  git(a, 'commit', '-m', 'Owner baseline');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-u', 'origin', 'main');
  const config = (root, mode = 'manual', remoteName = 'origin') => ({
    version: 1,
    projects: [],
    global: {
      path: path.join(root, 'memory'),
      sync:
        mode === 'local'
          ? { mode }
          : {
              mode,
              ...(mode === 'automatic' ? { authorized: true } : {}),
              ...(remoteName ? { remote: remoteName, branch: 'main' } : {}),
            },
    },
  });
  const configA = config(a);
  const engineA = new MemoryEngine(configA, a, path.join(directory, 'cache-a'));
  let record;
  if (seed) {
    record = (
      await engineA.remember(
        { scope: 'global' },
        { content: 'Use immutable SQLite memory revisions' },
      )
    ).record;
    const result = await synchronizeMemories(configA, { scope: 'global' }, a);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const clone = () => {
    git(directory, 'clone', remote, b);
    git(b, 'config', 'user.name', 'Membrain Test');
    git(b, 'config', 'user.email', 'membrain-test@example.invalid');
    git(b, 'config', 'core.autocrlf', 'false');
    const configB = config(b);
    return {
      configB,
      engineB: new MemoryEngine(configB, b, path.join(directory, 'cache-b')),
    };
  };
  const run = (root, cfg, args, extraEnv = {}) =>
    spawnSync(process.execPath, [cli, '--config', cfg, '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMBRAIN_CACHE_DIR: path.join(directory, 'cli-cache'),
        ...extraEnv,
      },
    });
  return {
    directory,
    remote,
    a,
    b,
    config,
    configA,
    engineA,
    record,
    clone,
    run,
  };
}
function first(report) {
  return report.results.find((item) => item.status !== 'skipped');
}
function success(report) {
  assert.equal(report.ok, true, JSON.stringify(report));
  return first(report);
}

test('fast checkpoints detect Git additive merges, imported updates and deletion tombstones', async (t) => {
  const f = await fixture(t);
  const { configB, engineB } = f.clone();
  const queryA = () =>
    f.engineA.query(
      { scope: 'global' },
      { query: 'SQLite', limit: 100, verification: 'fast' },
    );
  await queryA();
  await engineB.update({ scope: 'global' }, f.record.id, {
    content: 'SQLite remote updated decision',
  });
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'SQLite independent local merge decision' },
  );
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  const merged = await queryA();
  assert.equal(merged.results.length, 2);
  assert.match(
    merged.results.find(({ record }) => record.id === f.record.id).record
      .content,
    /remote updated/u,
  );
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  await engineB.forget({ scope: 'global' }, f.record.id);
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  const deleted = await queryA();
  assert.ok(deleted.results.every(({ record }) => record.id !== f.record.id));
  assert.deepEqual(
    deleted.results,
    (
      await f.engineA.query(
        { scope: 'global' },
        { query: 'SQLite', limit: 100 },
      )
    ).results,
  );
  assert.equal(git(f.a, 'status', '--porcelain'), '');
});

test('manual sync commits only managed files, repeats without commits, and preserves clean unrelated files', async (t) => {
  const f = await fixture(t, { seed: false });
  const before = git(f.a, 'rev-parse', 'HEAD');
  const saved = await f.engineA.remember(
    { scope: 'global' },
    { content: 'Manual local save before explicit sync' },
  );
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), before);
  const result = success(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(result.status, 'synchronized');
  assert.equal(
    await readFile(path.join(f.a, 'owner.txt'), 'utf8'),
    'Unrelated clean owner file\n',
  );
  const changed = git(
    f.a,
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    'HEAD',
  ).split('\n');
  assert.ok(changed.every((file) => file.startsWith('memory/')));
  assert.equal(changed.length, 2);
  assert.equal(git(f.a, 'status', '--porcelain'), '');
  assert.equal(
    git(f.remote, 'rev-parse', 'refs/heads/main'),
    git(f.a, 'rev-parse', 'HEAD'),
  );
  const head = git(f.a, 'rev-parse', 'HEAD');
  assert.equal(
    success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a))
      .status,
    'up-to-date',
  );
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
  assert.equal(
    (await readStore({ scope: 'global', path: f.configA.global.path }))
      .records[0].id,
    saved.record.id,
  );
});

test('CLI manual sync returns a structured report; commit-only policy never transmits', async (t) => {
  const f = await fixture(t, { seed: false });
  const cfg = path.join(f.directory, 'manual.json');
  const commitOnly = f.config(f.a, 'manual', '');
  await writeFile(cfg, JSON.stringify(commitOnly));
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Commit-only data stays local' },
  );
  const remote = git(f.remote, 'rev-parse', 'main');
  const result = f.run(f.a, cfg, ['sync', '--scope', 'global']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(first(JSON.parse(result.stdout)).status, 'committed');
  assert.equal(git(f.remote, 'rev-parse', 'main'), remote);
  assert.notEqual(git(f.a, 'rev-parse', 'HEAD'), remote);
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  assert.equal(
    git(f.remote, 'rev-parse', 'main'),
    git(f.a, 'rev-parse', 'HEAD'),
  );
  git(
    f.a,
    'commit',
    '--allow-empty',
    '-m',
    'api_key=synthetic_commit_metadata_12345',
  );
  const blocked = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(blocked.code, 'SECRET_DETECTED');
  assert.equal(JSON.stringify(blocked).includes('synthetic_commit'), false);
});

test('unrelated dirty, staged and untracked files stop before committing; index bytes stay untouched', async (t) => {
  const f = await fixture(t);
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Pending managed memory' },
  );
  const head = git(f.a, 'rev-parse', 'HEAD');
  const owner = path.join(f.a, 'owner.txt');
  await writeFile(owner, 'Unrelated owner edit\n');
  for (const staged of [false, true]) {
    if (staged) git(f.a, 'add', '--', 'owner.txt');
    const index = await readFile(path.join(f.a, '.git', 'index'));
    const result = first(
      await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
    );
    assert.equal(result.code, 'UNRELATED_CHANGES');
    assert.deepEqual(await readFile(path.join(f.a, '.git', 'index')), index);
    assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
    assert.equal(await readFile(owner, 'utf8'), 'Unrelated owner edit\n');
  }
  // The fixture owner explicitly restores its own test changes, outside Membrain.
  git(f.a, 'restore', '--staged', '--worktree', '--', 'owner.txt');
  await writeFile(path.join(f.a, 'scratch.txt'), 'owner scratch');
  assert.equal(
    first(await synchronizeMemories(f.configA, { scope: 'global' }, f.a)).code,
    'UNRELATED_CHANGES',
  );
});

test('local mode makes no Git calls, and automatic trigger skips manual stores', async (t) => {
  const f = await fixture(t, { seed: false });
  const local = f.config(f.a, 'local');
  const cfg = path.join(f.directory, 'local.json');
  await writeFile(cfg, JSON.stringify(local));
  const saved = f.run(
    f.a,
    cfg,
    ['remember', 'Local-only persisted memory', '--scope', 'global'],
    { PATH: '' },
  );
  assert.equal(saved.status, 0, saved.stderr);
  const result = f.run(f.a, cfg, ['sync', '--scope', 'global'], { PATH: '' });
  assert.equal(result.status, 1);
  assert.equal(
    JSON.parse(result.stdout).results[0].code,
    'LOCAL_SYNC_DISABLED',
  );
  const skipped = await synchronizeMemories(
    f.configA,
    { scope: 'global' },
    f.a,
    { trigger: 'automatic' },
  );
  assert.equal(skipped.results[0].status, 'skipped');
  assert.equal(git(f.a, 'log', '--format=%s', '-1'), 'Owner baseline');
});

test('two working copies merge independent revisions without duplication and propagate tombstones', async (t) => {
  const f = await fixture(t);
  const { configB, engineB } = f.clone();
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Writer A independent architecture' },
  );
  const local = (
    await engineB.remember(
      { scope: 'global' },
      { content: 'Writer B independent preferences' },
    )
  ).record;
  const recall = (engine) =>
    engine.query({ scope: 'global' }, { query: 'SQLite', limit: 10 });
  const beforeImport = await recall(engineB);
  assert.equal(beforeImport.index.rebuilt, false);
  assert.ok(
    beforeImport.results.some(({ record }) => record.id === f.record.id),
  );
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  const imported = await recall(engineB);
  assert.equal(imported.index.rebuilt, true);
  assert.equal((await recall(engineB)).index.rebuilt, false);
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  assert.equal(
    (await readStore({ scope: 'global', path: f.configA.global.path })).records
      .length,
    3,
  );
  await f.engineA.forget({ scope: 'global' }, f.record.id);
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  const afterDeletion = await recall(engineB);
  assert.equal(afterDeletion.index.rebuilt, true);
  assert.equal(
    afterDeletion.results.some(({ record }) => record.id === f.record.id),
    false,
  );
  assert.equal((await recall(engineB)).index.rebuilt, false);
  const snapshot = await readStore({
    scope: 'global',
    path: configB.global.path,
  });
  assert.equal(snapshot.records.length, 4);
  assert.equal(
    snapshot.entries.find((entry) => entry.record.id === f.record.id).record
      .status,
    'deleted',
  );
  assert.ok(snapshot.records.some((record) => record.id === local.id));
  const head = git(f.b, 'rev-parse', 'HEAD');
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), head);
});

test('delete/update semantic conflicts retain both histories without importing or pushing; explicit resolution recovers', async (t) => {
  const f = await fixture(t);
  const { configB, engineB } = f.clone();
  const updated = (
    await f.engineA.update({ scope: 'global' }, f.record.id, {
      content: 'Writer A new architectural decision',
    })
  ).record;
  const deleted = (await engineB.forget({ scope: 'global' }, f.record.id))
    .record;
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  const remote = git(f.remote, 'rev-parse', 'main');
  const local = git(f.b, 'rev-parse', 'HEAD');
  const conflict = first(
    await synchronizeMemories(configB, { scope: 'global' }, f.b),
  );
  assert.equal(conflict.code, 'SEMANTIC_CONFLICT');
  assert.ok(conflict.recoveryRef);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remote);
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), local);
  assert.equal(
    (await readStore({ scope: 'global', path: configB.global.path })).records
      .length,
    2,
  );
  // Owner-controlled advanced recovery: retain both complete revisions and add an explicit joining tombstone.
  const location = { scope: 'global', path: configB.global.path };
  await writeStore(location, async (_snapshot, assertOwned) => {
    await appendRevision(location, updated, assertOwned);
    await appendRevision(
      location,
      {
        ...deleted,
        revisionId: randomUUID(),
        parentRevisionIds: [updated.revisionId, deleted.revisionId],
        updatedAt: new Date(
          Math.max(
            Date.parse(updated.updatedAt),
            Date.parse(deleted.updatedAt),
          ) + 1,
        ).toISOString(),
      },
      assertOwned,
    );
  });
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  assert.equal(
    (await readStore({ scope: 'global', path: f.configA.global.path }))
      .entries[0].record.status,
    'deleted',
  );
});

test('offline sync is pending, retains local writes, and recovers after remote repair', async (t) => {
  const f = await fixture(t);
  const saved = await f.engineA.remember(
    { scope: 'global' },
    { content: 'Durable offline work' },
  );
  const head = git(f.a, 'rev-parse', 'HEAD');
  git(
    f.a,
    'remote',
    'set-url',
    'origin',
    path.join(f.directory, 'unavailable.git'),
  );
  const offline = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(offline.status, 'pending');
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
  assert.ok(
    (
      await readStore({ scope: 'global', path: f.configA.global.path })
    ).records.some((record) => record.id === saved.record.id),
  );
  git(f.a, 'remote', 'set-url', 'origin', f.remote);
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
});

test('authorized automatic CLI sync runs only after actual mutations and failure keeps saves successful', async (t) => {
  const f = await fixture(t, { seed: false });
  const automatic = f.config(f.a, 'automatic');
  const cfg = path.join(f.directory, 'automatic.json');
  await writeFile(cfg, JSON.stringify(automatic));
  let result = f.run(f.a, cfg, [
    'remember',
    'Automatic approved memory',
    '--scope',
    'global',
    '--operation-id',
    'auto-once',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.synchronization[0].ok, true, JSON.stringify(saved));
  const head = git(f.a, 'rev-parse', 'HEAD');
  result = f.run(f.a, cfg, [
    'remember',
    'Automatic approved memory',
    '--scope',
    'global',
    '--operation-id',
    'auto-once',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).synchronization, undefined);
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
  git(
    f.a,
    'remote',
    'set-url',
    'origin',
    path.join(f.directory, 'offline.git'),
  );
  result = f.run(f.a, cfg, [
    'update',
    saved.record.id,
    'Automatic memory updated offline',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(result.stdout);
  assert.ok(failed.warnings.some((warning) => warning.code === 'SYNC_PENDING'));
  assert.equal(failed.synchronization[0].ok, false);
  assert.equal(failed.record.id, saved.record.id);
  automatic.global.sync.authorized = false;
  await writeFile(cfg, JSON.stringify(automatic));
  result = f.run(f.a, cfg, [
    'remember',
    'Unauthorized should fail',
    '--scope',
    'global',
  ]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_CONFIG');
});

test('outgoing unrelated history and incoming unrelated changes are refused without transmitting them', async (t) => {
  const f = await fixture(t);
  f.clone();
  await writeFile(
    path.join(f.a, 'owner.txt'),
    'Owner committed unrelated work',
  );
  git(f.a, 'add', 'owner.txt');
  git(f.a, 'commit', '-m', 'Owner unrelated work');
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Memory after unrelated owner commit' },
  );
  const remote = git(f.remote, 'rev-parse', 'main');
  assert.equal(
    first(await synchronizeMemories(f.configA, { scope: 'global' }, f.a)).code,
    'UNRELATED_HISTORY',
  );
  assert.equal(git(f.remote, 'rev-parse', 'main'), remote);
  git(f.a, 'push', 'origin', 'main');
  const configB = f.config(f.b);
  const old = git(f.b, 'rev-parse', 'HEAD');
  assert.equal(
    first(await synchronizeMemories(configB, { scope: 'global' }, f.b)).code,
    'UNRELATED_HISTORY',
  );
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), old);
  assert.equal(
    await readFile(path.join(f.b, 'owner.txt'), 'utf8'),
    'Unrelated clean owner file\n',
  );
});

test('separate repositories/remotes and multiple scopes work; unselected manual changes block automatic scope', async (t) => {
  const f = await fixture(t);
  const other = path.join(f.directory, 'other');
  await initialize(other);
  const otherRemote = path.join(f.directory, 'other.git');
  await initialize(otherRemote, true);
  git(other, 'remote', 'add', 'backup', otherRemote);
  const config = {
    ...f.configA,
    projects: [
      {
        root: other,
        projectId: 'other',
        path: path.join(other, 'project-memory'),
        sync: { mode: 'manual', remote: 'backup', branch: 'main' },
      },
    ],
    session: {
      path: path.join(other, 'session-base'),
      sync: { mode: 'manual', remote: 'backup', branch: 'main' },
    },
  };
  const engine = new MemoryEngine(
    config,
    other,
    path.join(f.directory, 'multi-cache'),
  );
  await engine.remember(
    { scope: 'project' },
    { content: 'Independent project repository memory' },
  );
  success(await synchronizeMemories(config, { scope: 'project' }, other));
  assert.equal(
    git(otherRemote, 'rev-parse', 'main'),
    git(other, 'rev-parse', 'HEAD'),
  );
  await engine.remember(
    { scope: 'session', session: 'task-1' },
    { content: 'Explicit session synchronization only' },
  );
  const report = await synchronizeMemories(
    config,
    { scope: 'session', session: 'task-1' },
    other,
  );
  success(report);
  assert.equal(report.results[0].scopes[0].sessionId, 'task-1');
  assert.equal(git(other, 'ls-files').includes('session-base/'), true);
  const shared = {
    ...f.configA,
    projects: [
      {
        root: f.a,
        projectId: 'shared',
        path: path.join(f.a, 'project-memory'),
        sync: { mode: 'automatic', authorized: true },
      },
    ],
  };
  const sharedEngine = new MemoryEngine(
    shared,
    f.a,
    path.join(f.directory, 'shared-cache'),
  );
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Pending manual global memory' },
  );
  await sharedEngine.remember(
    { scope: 'project' },
    { content: 'Automatic project must not stage manual global' },
  );
  const head = git(f.a, 'rev-parse', 'HEAD');
  assert.equal(
    first(
      await synchronizeMemories(shared, { scope: 'project' }, f.a, {
        trigger: 'automatic',
      }),
    ).code,
    'UNRELATED_CHANGES',
  );
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
});

test('staged interruption is retryable; existing Git operation locks are never removed', async (t) => {
  const f = await fixture(t);
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Staged durable memory from an interrupted attempt' },
  );
  git(f.a, 'add', '--', 'memory');
  const lock = path.join(f.a, '.git', 'index.lock');
  await writeFile(lock, 'owner lock');
  assert.equal(
    first(await synchronizeMemories(f.configA, { scope: 'global' }, f.a)).code,
    'GIT_OPERATION_IN_PROGRESS',
  );
  assert.equal(await readFile(lock, 'utf8'), 'owner lock');
  await rm(lock);
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  assert.equal(git(f.a, 'status', '--porcelain'), '');
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(f.a, '.git', 'membrain-sync', 'progress.json'),
        'utf8',
      ),
    ).stage,
    'complete',
  );
  assert.deepEqual(await readdir(path.join(f.a, '.git', 'membrain-sync')), [
    'progress.json',
  ]);
});

test('concurrent copies either synchronize or report a rejected push, then converge without losing revisions', async (t) => {
  const f = await fixture(t);
  const { configB, engineB } = f.clone();
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Concurrent writer A' },
  );
  await engineB.remember(
    { scope: 'global' },
    { content: 'Concurrent writer B' },
  );
  const reports = await Promise.all([
    synchronizeMemories(f.configA, { scope: 'global' }, f.a),
    synchronizeMemories(configB, { scope: 'global' }, f.b),
  ]);
  assert.ok(reports.some((report) => report.ok));
  for (const report of reports)
    if (!report.ok)
      assert.equal(first(report).code, 'PUSH_REJECTED', JSON.stringify(report));
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  success(await synchronizeMemories(configB, { scope: 'global' }, f.b));
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  const left = await readStore({
    scope: 'global',
    path: f.configA.global.path,
  });
  const right = await readStore({ scope: 'global', path: configB.global.path });
  assert.equal(left.records.length, 3);
  assert.deepEqual(
    new Set(left.records.map((record) => record.revisionId)),
    new Set(right.records.map((record) => record.revisionId)),
  );
});

test('interruption immediately before push preserves its committed stage and retries without duplicate commits', async (t) => {
  const f = await fixture(t);
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Commit survives interrupted transmission' },
  );
  const remote = git(f.remote, 'rev-parse', 'main');
  const original = Git.prototype.run;
  const fault = t.mock.method(
    Git.prototype,
    'run',
    async function (args, ...rest) {
      if (args[0] === 'push')
        throw new MembrainError(
          'SYNC_INTERRUPTED',
          'Injected interruption after durable local commit.',
        );
      return original.call(this, args, ...rest);
    },
  );
  const interrupted = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(interrupted.status, 'pending');
  assert.equal(interrupted.stage, 'pushing');
  const committed = git(f.a, 'rev-parse', 'HEAD');
  assert.notEqual(committed, remote);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remote);
  fault.mock.restore();
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), committed);
  assert.equal(git(f.remote, 'rev-parse', 'main'), committed);
});

test('a concurrently staged unrelated file cannot contaminate the exact-path memory commit', async (t) => {
  const f = await fixture(t);
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Safe exact-path commit despite foreign staging race' },
  );
  const remote = git(f.remote, 'rev-parse', 'main');
  const original = Git.prototype.run;
  let injected = false;
  const fault = t.mock.method(
    Git.prototype,
    'run',
    async function (args, ...rest) {
      if (args[0] === 'commit' && !injected) {
        injected = true;
        await writeFile(
          path.join(f.a, 'owner.txt'),
          'Concurrent staged owner work',
        );
        git(f.a, 'add', '--', 'owner.txt');
      }
      return original.call(this, args, ...rest);
    },
  );
  const result = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  fault.mock.restore();
  assert.equal(result.code, 'UNRELATED_CHANGES');
  assert.equal(git(f.remote, 'rev-parse', 'main'), remote);
  assert.equal(git(f.a, 'diff', '--cached', '--name-only'), 'owner.txt');
  assert.equal(
    git(f.a, 'show', 'HEAD:owner.txt'),
    'Unrelated clean owner file',
  );
  assert.ok(
    git(f.a, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
      .split('\n')
      .every((file) => file.startsWith('memory/')),
  );
});

test('historical secrets, content filters, ignored paths, detached HEAD and branch mismatch fail safely', async (t) => {
  const f = await fixture(t);
  const before = git(f.a, 'rev-parse', 'HEAD');
  const wrong = {
    ...f.configA,
    global: {
      ...f.configA.global,
      sync: { mode: 'manual', remote: 'origin', branch: 'another' },
    },
  };
  assert.equal(
    first(await synchronizeMemories(wrong, { scope: 'global' }, f.a)).code,
    'WRONG_SYNC_BRANCH',
  );
  git(f.a, 'checkout', '--detach');
  assert.equal(
    first(await synchronizeMemories(f.configA, { scope: 'global' }, f.a)).code,
    'DETACHED_HEAD',
  );
  git(f.a, 'checkout', 'main');
  const attributes = path.join(f.a, '.gitattributes');
  await writeFile(attributes, 'memory/** filter=never-run\n');
  const result = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(result.code, 'UNSAFE_GIT_ATTRIBUTES');
  await rm(attributes);
  const info = path.join(f.a, '.git', 'info', 'exclude');
  await writeFile(info, 'memory/records/\n');
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Ignored source must never be force added' },
  );
  // Ignored revisions are still in the authoritative snapshot. Sync must diagnose them.
  const ignored = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(ignored.code, 'IGNORED_MEMORY_FILES', JSON.stringify(ignored));
  await writeFile(info, '');
  const original = f.record;
  const record = {
    ...original,
    id: randomUUID(),
    revisionId: randomUUID(),
    parentRevisionIds: [],
    content: 'api_key=synthetic_only_12345678',
    status: 'superseded',
  };
  await writeStore(
    { scope: 'global', path: f.configA.global.path },
    async (_snapshot, owned) =>
      appendRevision(
        { scope: 'global', path: f.configA.global.path },
        record,
        owned,
      ),
  );
  const secret = first(
    await synchronizeMemories(f.configA, { scope: 'global' }, f.a),
  );
  assert.equal(secret.code, 'SECRET_DETECTED');
  assert.equal(JSON.stringify(secret).includes('synthetic_only'), false);
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), before);
});

test('independently initialized store manifests conflict without replacing either source', async (t) => {
  const f = await fixture(t, { seed: false });
  const { configB, engineB } = f.clone();
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'First independently initialized store' },
  );
  await engineB.remember(
    { scope: 'global' },
    { content: 'Second independently initialized store' },
  );
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
  const before = await readFile(path.join(configB.global.path, 'store.json'));
  const head = git(f.b, 'rev-parse', 'HEAD');
  const result = first(
    await synchronizeMemories(configB, { scope: 'global' }, f.b),
  );
  assert.equal(result.code, 'IMMUTABLE_CONFLICT');
  assert.ok(result.recoveryRef);
  assert.deepEqual(
    await readFile(path.join(configB.global.path, 'store.json')),
    before,
  );
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), head);
});

test('Membrain Git commits disable configured repository hooks', async (t) => {
  const f = await fixture(t, { seed: false });
  const hooks = path.join(f.directory, 'owner-hooks');
  await mkdir(hooks);
  const hook = path.join(hooks, 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 77\n');
  await chmod(hook, 0o700);
  git(f.a, 'config', 'core.hooksPath', hooks);
  await f.engineA.remember(
    { scope: 'global' },
    { content: 'Memory commits must not execute owner hooks' },
  );
  success(await synchronizeMemories(f.configA, { scope: 'global' }, f.a));
});

test('inherited Git repository redirection cannot change another checkout or index', async (t) => {
  const f = await fixture(t);
  f.clone();
  const beforeHead = git(f.b, 'rev-parse', 'HEAD');
  const beforeIndex = await readFile(path.join(f.b, '.git', 'index'));
  await f.engineA.remember(
    { scope: 'global' },
    {
      content:
        'Keep repository and index selection inside the authorized scope',
    },
  );
  const overrides = {
    GIT_DIR: path.join(f.b, '.git'),
    GIT_WORK_TREE: f.b,
    GIT_INDEX_FILE: path.join(f.b, '.git', 'index'),
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  let report;
  try {
    Object.assign(process.env, overrides);
    report = await synchronizeMemories(f.configA, { scope: 'global' }, f.a);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  success(report);
  assert.notEqual(git(f.a, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), beforeHead);
  assert.deepEqual(
    await readFile(path.join(f.b, '.git', 'index')),
    beforeIndex,
  );
  assert.equal(git(f.b, 'status', '--porcelain'), '');
});

test('project markers and source files tolerate Git CRLF checkout conversion without changing identity', async (t) => {
  const f = await fixture(t, { seed: false });
  git(f.a, 'config', 'core.autocrlf', 'true');
  const cfg = path.join(f.directory, 'project.json');
  let result = f.run(f.a, cfg, [
    'init',
    '--non-interactive',
    '--project-root',
    f.a,
    '--project-sync',
    'manual',
    '--project-remote',
    'origin',
    '--project-branch',
    'main',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const initial = JSON.parse(result.stdout);
  result = f.run(f.a, cfg, [
    'remember',
    'Portable project memory',
    '--scope',
    'project',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  result = f.run(f.a, cfg, ['sync', '--scope', 'project']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const files = git(f.a, 'ls-files')
    .split('\n')
    .filter((file) => file.startsWith('.membrain/'));
  assert.ok(files.includes('.membrain/project.json'));
  for (const file of files) {
    const absolute = path.join(f.a, file);
    await writeFile(
      absolute,
      (await readFile(absolute, 'utf8'))
        .replace(/\r\n/gu, '\n')
        .replace(/\n/gu, '\r\n'),
    );
  }
  const head = git(f.a, 'rev-parse', 'HEAD');
  result = f.run(f.a, cfg, ['sync', '--scope', 'project']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(first(JSON.parse(result.stdout)).status, 'up-to-date');
  assert.equal(git(f.a, 'rev-parse', 'HEAD'), head);
  const manifest = JSON.parse(
    await readFile(path.join(f.a, '.membrain', 'project.json'), 'utf8'),
  );
  assert.equal(manifest.projectId, initial.project.projectId);
  const snapshot = await readStore({
    scope: 'project',
    projectId: manifest.projectId,
    path: initial.config.projects[0].path,
  });
  assert.equal(snapshot.records[0].id, saved.record.id);
});
