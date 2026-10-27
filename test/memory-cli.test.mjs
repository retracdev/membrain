import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const cwd = path.join(project, 'nested');
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(project, '.git'));
  const gitHead = path.join(project, '.git', 'HEAD');
  await writeFile(gitHead, 'ref: refs/heads/example\n');
  const index = path.join(project, '.git', 'index');
  await writeFile(index, 'unrelated fake index');
  const unrelated = path.join(project, 'unrelated.txt');
  await writeFile(unrelated, 'leave me alone');
  const config = path.join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      global: {
        path: './fleet',
        sync: { mode: 'automatic', authorized: true },
      },
      projects: [
        {
          projectId: 'example',
          root: project,
          path: './project/.membrain/memory',
          sync: { mode: 'manual' },
        },
      ],
      session: { path: './session data' },
    }),
  );
  const env = {
    ...process.env,
    PATH: '',
    MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
  };
  return {
    directory,
    cwd,
    project,
    gitHead,
    index,
    unrelated,
    run: (args, input) =>
      spawnSync(
        process.execPath,
        [cli, '--config', config, '--json', ...args],
        { cwd, env, input, encoding: 'utf8', timeout: 10_000 },
      ),
  };
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
function error(result, code) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.equal(result.stdout, '');
}

test('CLI demonstrates CRUD, recall budgets, isolation, rebuild, stdin and no Git writes', async (t) => {
  const f = await fixture(t);
  for (const command of [
    'remember',
    'recall',
    'search',
    'list',
    'update',
    'forget',
  ])
    assert.equal(f.run([command, '--help']).status, 0);
  const saved = ok(
    f.run(
      [
        'remember',
        '--stdin',
        '--type',
        'decision',
        '--tag',
        'architecture',
        '--metadata',
        '{"reason":"offline"}',
        '--source-agent',
        'test',
        '--operation-id',
        'demo-create',
      ],
      'Prefer SQLite for deterministic local search.',
    ),
  );
  assert.equal(saved.record.projectId, 'example');
  const recalled = ok(f.run(['recall', 'SQLite']));
  assert.equal(recalled.untrusted, true);
  assert.equal(recalled.results[0].id, saved.record.id);
  assert.ok(JSON.stringify(recalled.results).length <= 4000);
  const updated = ok(
    f.run([
      'update',
      saved.record.id,
      'Prefer SQLite FTS5 with BM25.',
      '--expected-revision',
      saved.record.revisionId,
    ]),
  );
  assert.equal(updated.record.id, saved.record.id);
  error(
    f.run([
      'update',
      saved.record.id,
      'stale',
      '--expected-revision',
      saved.record.revisionId,
    ]),
    'STALE_REVISION',
  );
  ok(f.run(['remember', 'Global preference', '--scope', 'global']));
  ok(
    f.run([
      'remember',
      'Private session task',
      '--scope',
      'session',
      '--session',
      's1',
    ]),
  );
  assert.equal(ok(f.run(['search', 'Private'])).results.length, 0);
  assert.equal(
    ok(f.run(['search', 'Private', '--scope', 'session', '--session', 's1']))
      .results.length,
    1,
  );
  assert.equal(ok(f.run(['list', '--scope', 'global'])).results.length, 1);
  const rebuilt = ok(f.run(['search', 'BM25', '--rebuild-index']));
  assert.equal(rebuilt.index.rebuilt, true);
  error(f.run(['forget', saved.record.id]), 'CONFIRMATION_REQUIRED');
  assert.equal(
    ok(f.run(['forget', saved.record.id, '--yes'])).record.status,
    'deleted',
  );
  assert.equal(ok(f.run(['recall', 'BM25'])).results.length, 0);
  assert.equal(
    ok(f.run(['list', '--scope', 'project', '--status', 'all', '--history']))
      .results.length,
    3,
  );
  assert.equal(await readFile(f.gitHead, 'utf8'), 'ref: refs/heads/example\n');
  assert.equal(await readFile(f.index, 'utf8'), 'unrelated fake index');
  assert.equal(await readFile(f.unrelated, 'utf8'), 'leave me alone');
  assert.deepEqual((await readdir(path.join(f.project, '.git'))).sort(), [
    'HEAD',
    'index',
  ]);
});

test('CLI rejects malformed input without prompts or secret echo; no-match is success', async (t) => {
  const f = await fixture(t);
  error(f.run(['remember']), 'CONTENT_REQUIRED');
  error(
    f.run(['remember', 'text', '--stdin'], 'another text'),
    'INVALID_INPUT',
  );
  error(
    f.run(['remember', 'text', '--metadata', 'invalid']),
    'INVALID_METADATA',
  );
  error(
    f.run(['remember', 'api_key=syntheticCredential12345']),
    'SECRET_DETECTED',
  );
  error(f.run(['search', '!!!']), 'INVALID_QUERY');
  error(f.run(['search', 'word', '--limit', '-1']), 'INVALID_LIMIT');
  error(
    f.run(['remember', 'session', '--scope', 'session']),
    'SESSION_REQUIRED',
  );
  error(f.run(['remember', 'text', '--project', 'unknown']), 'UNKNOWN_PROJECT');
  assert.equal(ok(f.run(['search', 'noresults'])).results.length, 0);
  const long = ok(f.run(['remember', `budget ${'x'.repeat(5000)}`]));
  const bounded = ok(f.run(['recall', 'budget', '--max-chars', '500']));
  assert.ok(JSON.stringify(bounded.results).length <= 500);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.results[0].id, long.record.id);
  assert.deepEqual(
    ok(f.run(['recall', 'budget', '--max-chars', '1'])).results,
    [],
  );
});

test('CLI session promotion/discard is explicit and preserves permanent memory', async (t) => {
  const f = await fixture(t);
  const saved = ok(
    f.run([
      'remember',
      'Temporary tested finding',
      '--scope',
      'session',
      '--session',
      'work',
    ]),
  );
  const promoted = ok(
    f.run([
      'remember',
      '--promote',
      saved.record.id,
      '--session',
      'work',
      '--to',
      'project',
    ]),
  );
  assert.equal(promoted.record.origin.id, saved.record.id);
  assert.equal(
    ok(
      f.run([
        'remember',
        '--promote',
        saved.record.id,
        '--session',
        'work',
        '--to',
        'project',
      ]),
    ).record.id,
    promoted.record.id,
  );
  ok(
    f.run([
      'forget',
      '--all',
      '--scope',
      'session',
      '--session',
      'work',
      '--yes',
    ]),
  );
  assert.equal(
    ok(f.run(['list', '--scope', 'session', '--session', 'work'])).results
      .length,
    0,
  );
  assert.equal(ok(f.run(['list', '--scope', 'project'])).results.length, 1);
});

test('CLI can clear tags explicitly and rejects ambiguous tag updates', async (t) => {
  const f = await fixture(t);
  const saved = ok(
    f.run(['remember', 'tagged memory', '--tag', 'one', '--tag', 'two']),
  );
  assert.deepEqual(saved.record.tags, ['one', 'two']);
  error(
    f.run(['update', saved.record.id, '--clear-tags', '--tag', 'three']),
    'INVALID_UPDATE',
  );
  const cleared = ok(f.run(['update', saved.record.id, '--clear-tags']));
  assert.deepEqual(cleared.record.tags, []);
});
