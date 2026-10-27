import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const temporaryRoot = await realpath(os.tmpdir());
const directory = await realpath(
  await mkdtemp(path.join(temporaryRoot, 'membrain-init-demo-')),
);
assert.ok(
  path.dirname(directory) === temporaryRoot &&
    path.basename(directory).startsWith('membrain-init-demo-'),
  'Unexpected demo cleanup target',
);
try {
  const root = path.join(directory, 'code');
  const nested = path.join(root, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  const config = path.join(directory, 'settings', 'config.json');
  const env = {
    ...process.env,
    PATH: '',
    MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
  };
  delete env.MEMBRAIN_CONFIG;
  function run(args, cwd = nested) {
    const result = spawnSync(
      process.execPath,
      [cli, '--config', config, '--json', ...args],
      { cwd, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const args = [
    'init',
    '--non-interactive',
    '--project-root',
    root,
    '--global-path',
    path.join(directory, 'custom global'),
    '--project-path',
    path.join(directory, 'custom project'),
    '--session-path',
    path.join(directory, 'custom sessions'),
  ];
  const initialized = run(args);
  const stores = [
    initialized.config.global,
    ...initialized.config.projects,
    initialized.config.session,
  ];
  assert.ok(stores.every((store) => store.sync.mode === 'local'));
  const global = run([
    'remember',
    'Prefer small dependencies',
    '--scope',
    'global',
  ]);
  const project = run([
    'remember',
    'Use SQLite for this project',
    '--scope',
    'project',
  ]);
  const session = run([
    'remember',
    'Finish the setup review',
    '--scope',
    'session',
    '--session',
    'task-1',
  ]);
  const expected = [global.record.id, project.record.id].sort();
  assert.deepEqual(
    run(['list'])
      .results.map((item) => item.record.id)
      .sort(),
    expected,
  );
  assert.deepEqual(
    run(['list'], directory).results.map((item) => item.record.id),
    [global.record.id],
  );
  assert.deepEqual(
    run(['list', '--scope', 'session', '--session', 'task-1']).results.map(
      (item) => item.record.id,
    ),
    [session.record.id],
  );
  assert.equal(
    run(['list', '--scope', 'session', '--session', 'task-2']).results.length,
    0,
  );
  const before = await readFile(config, 'utf8');
  const repeat = run(args);
  assert.equal(repeat.status, 'unchanged');
  assert.equal(await readFile(config, 'utf8'), before);
  assert.deepEqual(
    run(['list'])
      .results.map((item) => item.record.id)
      .sort(),
    expected,
  );
  assert.equal(
    run(['list', '--scope', 'session', '--session', 'task-1']).results[0].record
      .id,
    session.record.id,
  );
  console.log(
    JSON.stringify(
      {
        initialization: initialized.status,
        customLocations: stores.map((store) => ({
          path: store.path,
          policy: store.sync.mode,
        })),
        savedScopes: [
          global.record.scope,
          project.record.scope,
          session.record.scope,
        ],
        nestedProjectRecall: run(['recall', 'SQLite']).results.map(
          (item) => item.id,
        ),
        scopeIsolation:
          'global available outside project; project excluded outside root; task-2 cannot see task-1',
        reinitialization: repeat.status,
        configurationBytesPreserved: true,
        allMemoryIdsPreserved: true,
        gitExecutableAvailable: false,
        gitOperations: 'none',
        integrations: 'unavailable',
        cleanup: 'temporary fixture removed after demonstration',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
