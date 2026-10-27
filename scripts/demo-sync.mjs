import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, URL } from 'node:url';
const temporary = await realpath(os.tmpdir());
const directory = await realpath(
  await mkdtemp(path.join(temporary, 'membrain-sync-demo-')),
);
assert.ok(
  path.dirname(directory) === temporary &&
    path.basename(directory).startsWith('membrain-sync-demo-'),
);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
};
delete env.MEMBRAIN_CONFIG;
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
try {
  const a = path.join(directory, 'work-a'),
    b = path.join(directory, 'work-b'),
    remote = path.join(directory, 'remote.git');
  await mkdir(remote);
  git(remote, 'init', '--bare', '--initial-branch=main');
  await mkdir(a);
  git(a, 'init', '--initial-branch=main');
  for (const [key, value] of [
    ['user.name', 'Membrain Demo'],
    ['user.email', 'membrain-demo@example.invalid'],
    ['core.autocrlf', 'false'],
  ])
    git(a, 'config', key, value);
  await writeFile(path.join(a, 'owner.txt'), 'Unrelated owner data\n');
  git(a, 'add', 'owner.txt');
  git(a, 'commit', '-m', 'Owner baseline');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', 'origin', 'main');
  const config = (root, mode) => ({
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
              remote: 'origin',
              branch: 'main',
            },
    },
  });
  const manual = path.join(directory, 'manual.json'),
    automatic = path.join(directory, 'automatic.json'),
    local = path.join(directory, 'local.json'),
    manualB = path.join(directory, 'manual-b.json');
  await writeFile(manual, JSON.stringify(config(a, 'manual')));
  await writeFile(automatic, JSON.stringify(config(a, 'automatic')));
  const run = (root, cfg, args, status = 0, offlineGit = false) => {
    const result = spawnSync(
      process.execPath,
      [cli, '--config', cfg, '--json', ...args],
      {
        cwd: root,
        env: { ...env, ...(offlineGit ? { PATH: '' } : {}) },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, status, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const saved = run(a, manual, [
    'remember',
    'Use immutable memories',
    '--scope',
    'global',
  ]);
  const manualResult = run(a, manual, ['sync', '--scope', 'global']);
  assert.equal(manualResult.ok, true, JSON.stringify(manualResult));
  const automaticResult = run(a, automatic, [
    'remember',
    'Automatic scope was explicitly authorized',
    '--scope',
    'global',
  ]);
  assert.equal(
    automaticResult.synchronization[0].ok,
    true,
    JSON.stringify(automaticResult),
  );
  git(directory, 'clone', remote, b);
  for (const [key, value] of [
    ['user.name', 'Membrain Demo'],
    ['user.email', 'membrain-demo@example.invalid'],
    ['core.autocrlf', 'false'],
  ])
    git(b, 'config', key, value);
  await writeFile(local, JSON.stringify(config(b, 'local')));
  await writeFile(manualB, JSON.stringify(config(b, 'manual')));
  const localHead = git(b, 'rev-parse', 'HEAD');
  run(
    b,
    local,
    ['remember', 'Local data stays local', '--scope', 'global'],
    0,
    true,
  );
  const localResult = run(b, local, ['sync', '--scope', 'global'], 1, true);
  assert.equal(localResult.results[0].code, 'LOCAL_SYNC_DISABLED');
  assert.equal(git(b, 'rev-parse', 'HEAD'), localHead);
  await writeFile(path.join(a, 'owner.txt'), 'Owner staged work\n');
  git(a, 'add', 'owner.txt');
  const index = await readFile(path.join(a, '.git', 'index'));
  const stagedResult = run(a, manual, ['sync', '--scope', 'global'], 1);
  assert.equal(stagedResult.results[0].code, 'UNRELATED_CHANGES');
  assert.deepEqual(await readFile(path.join(a, '.git', 'index')), index);
  // Fixture owner restores only its own test edit, outside Membrain.
  git(a, 'restore', '--staged', '--worktree', '--', 'owner.txt');
  run(a, manual, [
    'update',
    saved.record.id,
    'New architecture after offline work',
  ]);
  git(a, 'remote', 'set-url', 'origin', path.join(directory, 'missing.git'));
  const offline = run(a, manual, ['sync', '--scope', 'global'], 1);
  assert.equal(offline.results[0].status, 'pending');
  git(a, 'remote', 'set-url', 'origin', remote);
  assert.equal(run(a, manual, ['sync', '--scope', 'global']).ok, true);
  run(
    b,
    local,
    ['forget', saved.record.id, '--scope', 'global', '--yes'],
    0,
    true,
  );
  const remoteHead = git(remote, 'rev-parse', 'main');
  const conflict = run(b, manualB, ['sync', '--scope', 'global'], 1);
  assert.equal(conflict.results[0].code, 'SEMANTIC_CONFLICT');
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
  console.log(
    JSON.stringify(
      {
        manual: manualResult.results[0].status,
        authorizedAutomatic:
          automaticResult.synchronization[0].results[0].status,
        localOnly: localResult.results[0].code,
        unrelatedIndexPreserved: true,
        offline: offline.results[0].status,
        conflict: conflict.results[0].code,
        conflictingHistoriesRetained: true,
        remotes: 'isolated local bare Git only',
        cleanup: 'temporary fixture removed after demonstration',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
