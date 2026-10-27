import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const directory = await mkdtemp(path.join(os.tmpdir(), 'membrain-demo-'));
assert.ok(
  directory.startsWith(path.join(os.tmpdir(), 'membrain-demo-')),
  'Unexpected demo cleanup path',
);
try {
  const project = path.join(directory, 'project');
  await mkdir(path.join(project, 'nested'), { recursive: true });
  const config = path.join(directory, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      global: { path: './global' },
      projects: [
        { projectId: 'demo', root: project, path: './project-memory' },
      ],
      session: { path: './sessions' },
    }),
  );
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const env = {
    ...process.env,
    PATH: '',
    MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
  };
  function run(...args) {
    const result = spawnSync(
      process.execPath,
      [cli, '--config', config, '--json', ...args],
      { cwd: path.join(project, 'nested'), env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const saved = run(
    'remember',
    'Use SQLite FTS5 for local search',
    '--type',
    'decision',
    '--operation-id',
    'demo-create',
  );
  const recalled = run('recall', 'SQLite search');
  assert.equal(recalled.results[0].id, saved.record.id);
  const updated = run(
    'update',
    saved.record.id,
    'Use SQLite FTS5 and BM25',
    '--expected-revision',
    saved.record.revisionId,
  );
  assert.equal(updated.record.id, saved.record.id);
  run('remember', 'Shared global coding preference', '--scope', 'global');
  run(
    'remember',
    'Private session next step',
    '--scope',
    'session',
    '--session',
    'demo-session',
  );
  const hiddenSessionMatches = run('search', 'Private').results.length;
  const explicitSessionMatches = run(
    'search',
    'Private',
    '--scope',
    'session',
    '--session',
    'demo-session',
  ).results.length;
  assert.equal(hiddenSessionMatches, 0);
  assert.equal(explicitSessionMatches, 1);
  const rebuilt = run('search', 'BM25', '--rebuild-index');
  assert.equal(rebuilt.index.rebuilt, true);
  const deleted = run('forget', saved.record.id, '--yes');
  assert.equal(deleted.record.status, 'deleted');
  const afterDelete = run('recall', 'BM25');
  assert.equal(afterDelete.results.length, 0);
  const history = run(
    'list',
    '--scope',
    'project',
    '--status',
    'all',
    '--history',
  );
  assert.equal(history.results.length, 3);
  console.log(
    JSON.stringify(
      {
        savedMemoryId: saved.record.id,
        recalledMemoryId: recalled.results[0].id,
        updatedRevisionId: updated.record.revisionId,
        scopeIsolation: { hiddenSessionMatches, explicitSessionMatches },
        rebuiltIndex: rebuilt.index.rebuilt,
        deletedState: deleted.record.status,
        matchesAfterDeletion: afterDelete.results.length,
        retainedRevisions: history.results.length,
        gitExecutableAvailable: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
