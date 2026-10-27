import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    APPDATA: directory,
    XDG_CONFIG_HOME: directory,
    MEMBRAIN_CONFIG: '',
    PATH: '',
  };
  delete env.MEMBRAIN_CONFIG;
  return {
    directory,
    run: (...args) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: directory,
        env,
        encoding: 'utf8',
      }),
  };
}

test('help and version work without configuration', async (t) => {
  const { run, directory } = await fixture(t);
  for (const args of [[], ['--help'], ['status', '--help']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/u);
    assert.equal(result.stderr, '');
  }
  const version = run('--version');
  const metadata = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(version.stdout.trim(), metadata.version);
  assert.deepEqual(await readdir(directory), []);
});

test('unconfigured status is read-only with machine-readable output', async (t) => {
  const { run, directory } = await fixture(t);
  const result = run('status', '--json');
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.configured, false);
  assert.deepEqual(data.config.projects, []);
  assert.equal(data.synchronization, 'available');
  assert.equal(result.stderr, '');
  assert.deepEqual(await readdir(directory), []);
});

test('status reads explicit custom locations without requiring Git or creating storage', async (t) => {
  const { run, directory } = await fixture(t);
  const configPath = path.join(directory, 'config.json');
  const original = JSON.stringify({ version: 1, global: { path: './fleet' } });
  await writeFile(configPath, original);
  const result = run('--config', configPath, 'status', '--json');
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.config.global, {
    path: path.join(directory, 'fleet'),
    sync: { mode: 'local' },
  });
  assert.deepEqual(await readdir(directory), ['config.json']);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('bad and explicitly missing configuration return actionable JSON errors', async (t) => {
  const { run, directory } = await fixture(t);
  const missing = run(
    'status',
    '--config',
    path.join(directory, 'missing.json'),
    '--json',
  );
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'CONFIG_READ_FAILED');
  assert.equal(missing.stdout, '');
  const configPath = path.join(directory, 'bad.json');
  await writeFile(configPath, '{ sensitive-invalid-content');
  const malformed = run('--json', '--config', configPath, 'status');
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stderr).error.code, 'INVALID_CONFIG');
  assert.doesNotMatch(malformed.stderr, /sensitive-invalid-content/u);
});

test('planned commands fail explicitly and never write data', async (t) => {
  const { run, directory } = await fixture(t);
  for (const command of ['doctor']) {
    const result = run(command, '--json');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'NOT_IMPLEMENTED');
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(directory), []);
});

test('invalid usage returns nonzero JSON errors', async (t) => {
  const { run } = await fixture(t);
  for (const args of [
    ['--json', 'unknown'],
    ['status', '--json', '--unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'USAGE_ERROR');
    assert.equal(result.stdout, '');
  }
});
