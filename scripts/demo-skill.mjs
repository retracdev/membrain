import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const temporaryRoot = await realpath(os.tmpdir());
const directory = await mkdtemp(
  path.join(temporaryRoot, 'membrain-skill-demo-'),
);
const destination = path.join(directory, 'review', 'membrain');
const args = ['skill', 'export', '--output', destination, '--json'];
function run(extra = []) {
  return spawnSync(process.execPath, [cli, ...args, ...extra], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: directory,
      XDG_CONFIG_HOME: directory,
      CODEX_HOME: path.join(directory, 'mock-codex'),
      CLAUDE_CONFIG_DIR: path.join(directory, 'mock-claude'),
      MEMBRAIN_CONFIG: path.join(directory, 'missing-config.json'),
      PATH: '',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}
try {
  const created = run();
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).status, 'created');
  console.log(created.stdout.trim());
  const file = path.join(destination, 'SKILL.md');
  assert.deepEqual(
    await readFile(file),
    await readFile(new URL('../skills/membrain/SKILL.md', import.meta.url)),
  );
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'unchanged');
  console.log(repeated.stdout.trim());
  await writeFile(file, 'isolated owner customization');
  const refused = run();
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error.code, 'SKILL_EXISTS');
  assert.equal(await readFile(file, 'utf8'), 'isolated owner customization');
  console.log('Different existing skill preserved without --overwrite.');
  const replaced = run(['--overwrite']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(replaced.stdout).status, 'replaced');
  console.log(replaced.stdout.trim());
  assert.deepEqual(await readdir(destination), ['SKILL.md']);
  assert.deepEqual(await readdir(directory), ['review']);
  console.log(
    'Only the selected temporary destination was written; nothing installed or activated.',
  );
} finally {
  assert.equal(path.dirname(directory), temporaryRoot);
  assert.ok(path.basename(directory).startsWith('membrain-skill-demo-'));
  await rm(directory, { recursive: true, force: true });
}
