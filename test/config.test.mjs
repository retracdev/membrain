import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig, resolveConfigPath } from '../dist/config.js';

const base = path.resolve('test-fixtures', 'config.json');
const home = path.resolve('test-home');

test('configuration paths honor explicit flag, environment, and platform defaults', () => {
  const context = { cwd: path.dirname(base), home, env: {}, platform: 'linux' };
  assert.equal(
    resolveConfigPath('custom.json', context),
    path.join(path.dirname(base), 'custom.json'),
  );
  assert.equal(
    resolveConfigPath(undefined, {
      ...context,
      env: { MEMBRAIN_CONFIG: '~/fleet/config.json' },
    }),
    path.join(home, 'fleet', 'config.json'),
  );
  assert.equal(
    resolveConfigPath('flag.json', {
      ...context,
      env: { MEMBRAIN_CONFIG: 'env.json' },
    }),
    path.join(path.dirname(base), 'flag.json'),
  );
  assert.equal(
    resolveConfigPath(undefined, context),
    path.join(home, '.config', 'membrain', 'config.json'),
  );
  assert.equal(
    resolveConfigPath(undefined, { ...context, platform: 'win32' }),
    path.join(home, 'AppData', 'Roaming', 'membrain', 'config.json'),
  );
});

test('all configured scopes independently default to local even at Git-like paths', () => {
  const config = parseConfig(
    {
      version: 1,
      global: { path: '~/fleet/memory' },
      projects: [
        {
          projectId: 'project-1',
          root: '../project',
          path: '../project/.membrain',
        },
      ],
      session: { path: './sessions' },
    },
    base,
    home,
  );
  assert.deepEqual(config.global.sync, { mode: 'local' });
  assert.deepEqual(config.projects[0].sync, { mode: 'local' });
  assert.deepEqual(config.session.sync, { mode: 'local' });
  assert.equal(config.global.path, path.join(home, 'fleet', 'memory'));
  assert.equal(
    config.projects[0].root,
    path.resolve(path.dirname(base), '../project'),
  );
});

test('manual and automatic policies are independent and do not imply Git execution', () => {
  const config = parseConfig(
    {
      version: 1,
      global: {
        path: './global',
        sync: { mode: 'manual', remote: 'origin', branch: 'memory' },
      },
      session: {
        path: './session',
        sync: { mode: 'automatic', authorized: true },
      },
    },
    base,
  );
  assert.equal(config.global.sync.mode, 'manual');
  assert.deepEqual(config.session.sync, {
    mode: 'automatic',
    authorized: true,
  });
  assert.deepEqual(config.projects, []);
});

test('invalid and potentially unsafe configuration fails closed', () => {
  for (const input of [
    null,
    { version: 2 },
    { version: 1, telemetry: true },
    { version: 1, projects: {} },
    { version: 1, global: { path: '' } },
    { version: 1, session: { path: './s', sync: { mode: 'automatic' } } },
    {
      version: 1,
      session: { path: './s', sync: { mode: 'automatic', authorized: false } },
    },
    {
      version: 1,
      global: { path: './g', sync: { mode: 'local', remote: 'origin' } },
    },
    {
      version: 1,
      global: { path: './g', sync: { mode: 'manual', authorized: true } },
    },
    {
      version: 1,
      global: {
        path: './g',
        sync: { mode: 'manual', remote: 'https://token@example.com/repo' },
      },
    },
    {
      version: 1,
      global: { path: './g', sync: { mode: 'manual', branch: '--all' } },
    },
    { version: 1, global: { path: './g\u0000' } },
    {
      version: 1,
      projects: [
        { projectId: 'a', root: './repo', path: './a' },
        { projectId: 'b', root: './repo', path: './b' },
      ],
    },
  ]) {
    assert.throws(() => parseConfig(input, base), { code: 'INVALID_CONFIG' });
  }
});
