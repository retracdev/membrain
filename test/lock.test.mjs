import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withLock } from '../dist/storage/files.js';

test('lock acquisition retries transient Windows EPERM without assuming ownership', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'membrain-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const mkdir = fs.mkdir;
  let attempts = 0;
  let actions = 0;
  const denied = Object.assign(new Error('fixture permission denied'), {
    code: 'EPERM',
  });
  const interception = t.mock.method(fs, 'mkdir', async (...args) => {
    attempts++;
    if (attempts === 1) throw denied;
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    const acquisition = withLock(directory, async (assertOwned) => {
      actions++;
      await assertOwned();
      assert.equal(attempts, 2);
      assert.ok(
        JSON.parse(
          await fs.readFile(
            path.join(directory, '.membrain-lock', 'owner.json'),
            'utf8',
          ),
        ).token,
      );
    });
    if (process.platform === 'win32') {
      await acquisition;
      assert.equal(actions, 1);
    } else {
      await assert.rejects(acquisition, (error) => error === denied);
      assert.equal(actions, 0);
      assert.equal(attempts, 1);
    }
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    interception.mock.restore();
    syncBuiltinESMExports();
  }
});

test('persistent lock permission failures stay bounded and never run the action', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'membrain-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let actions = 0;
  for (const code of ['EPERM', 'EACCES']) {
    const denied = Object.assign(new Error('fixture permission denied'), {
      code,
    });
    const interception = t.mock.method(fs, 'mkdir', async () => {
      throw denied;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        withLock(
          directory,
          async () => {
            actions++;
          },
          0,
        ),
        (error) => error === denied,
      );
      assert.deepEqual(await fs.readdir(directory), []);
    } finally {
      interception.mock.restore();
      syncBuiltinESMExports();
    }
  }
  assert.equal(actions, 0);
});
