import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  symlink,
  cp,
  chmod,
  stat,
  link,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { test } from 'node:test';
import { exportSkill } from '../dist/skill.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist', 'cli.js');
const bundled = await readFile(
  path.join(root, 'skills', 'membrain', 'SKILL.md'),
);

async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'membrain-skill-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('membrain-skill-'));
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
    CODEX_HOME: path.join(directory, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
    MEMBRAIN_CONFIG: path.join(directory, 'intentionally-missing.json'),
    MEMBRAIN_CACHE_DIR: path.join(directory, 'cache'),
    PATH: '',
  };
  delete env.T3_ACP_MCP_NODE;
  const options = { cwd: directory, env, encoding: 'utf8', timeout: 20_000 };
  return {
    directory,
    options,
    run: (...args) => spawnSync(process.execPath, [cli, ...args], options),
  };
}

test('portable skill has standard frontmatter and no extra executable assets', async () => {
  const text = bundled.toString('utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)?.[1];
  assert.ok(frontmatter);
  const fields = {};
  let key;
  for (const line of frontmatter.split(/\r?\n/u)) {
    if (/^\s/u.test(line)) {
      assert.ok(key, 'A continuation needs a field');
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    } else {
      const colon = line.indexOf(':');
      assert.ok(colon > 0);
      key = line.slice(0, colon);
      assert.ok(!Object.hasOwn(fields, key), 'No duplicate frontmatter fields');
      fields[key] = line.slice(colon + 1).trim();
    }
  }
  assert.equal(fields.name, 'membrain');
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024);
  assert.deepEqual(Object.keys(fields).sort(), [
    'description',
    'license',
    'name',
  ]);
  assert.deepEqual(await readdir(path.join(root, 'skills', 'membrain')), [
    'SKILL.md',
  ]);
});

test('export requires an explicit destination and help creates no files', async (t) => {
  const { directory, run } = await fixture(t);
  for (const args of [
    ['skill', 'export'],
    ['skill', 'export', '--output', ''],
    ['skill', 'export', '--install'],
  ]) {
    const result = run(...args, '--json');
    assert.equal(result.status, 2, result.stderr);
    assert.ok(
      ['USAGE_ERROR', 'INVALID_SKILL_OUTPUT'].includes(
        JSON.parse(result.stderr).error.code,
      ),
    );
    assert.equal(result.stdout, '');
  }
  for (const args of [
    ['skill'],
    ['skill', '--help'],
    ['skill', 'export', '--help'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/u);
  }
  assert.deepEqual(await readdir(directory), []);
});

test('offline export works without configuration, Git, agents, or a project', async (t) => {
  const { directory, run } = await fixture(t);
  const result = run(
    'skill',
    'export',
    '--output',
    './custom path/membrain',
    '--json',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const file = path.join(directory, 'custom path', 'membrain', 'SKILL.md');
  assert.deepEqual(JSON.parse(result.stdout), {
    skill: 'membrain',
    path: file,
    status: 'created',
  });
  assert.deepEqual(await readFile(file), bundled);
  assert.deepEqual(await readdir(directory), ['custom path']);
  assert.deepEqual(await readdir(path.dirname(file)), ['SKILL.md']);
});

test('repeated export leaves identical bytes and timestamps untouched', async (t) => {
  const { directory } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  const created = await exportSkill(dest);
  const before = await stat(created.path);
  assert.equal((await exportSkill(dest)).status, 'unchanged');
  assert.equal((await exportSkill(dest, true)).status, 'unchanged');
  assert.equal((await stat(created.path)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(dest), ['SKILL.md']);
});

test('an identical publication after observing a missing target is idempotent', async (t) => {
  const { directory } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  const target = path.join(dest, 'SKILL.md');
  await mkdir(dest);
  const original = fsPromises.lstat;
  let published = false;
  const interception = t.mock.method(
    fsPromises,
    'lstat',
    async (file, ...options) => {
      if (file === target && !published) {
        // Another writer publishes immediately after our absence observation.
        published = true;
        await writeFile(target, bundled);
        throw Object.assign(new Error('Observed missing target'), {
          code: 'ENOENT',
        });
      }
      return original(file, ...options);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.equal((await exportSkill(dest)).status, 'unchanged');
    assert.equal(published, true);
    assert.deepEqual(await readFile(target), bundled);
    assert.deepEqual(await readdir(dest), ['SKILL.md']);
  } finally {
    interception.mock.restore();
    syncBuiltinESMExports();
  }
});

test('human export output reports only export and preserves neighboring fixture agent settings', async (t) => {
  const { directory, run } = await fixture(t);
  const dest = path.join(directory, '.claude', 'skills', 'membrain');
  const settings = path.join(directory, '.claude', 'settings.json');
  await mkdir(path.dirname(settings));
  await writeFile(settings, 'owner settings');
  const result = run('skill', 'export', '--output', dest);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Only SKILL\.md was exported/u);
  assert.match(result.stdout, /agents may discover/u);
  assert.doesNotMatch(result.stdout, /Nothing was installed or activated/u);
  assert.equal(await readFile(settings, 'utf8'), 'owner settings');
  assert.deepEqual(await readFile(path.join(dest, 'SKILL.md')), bundled);
  assert.deepEqual((await readdir(path.dirname(settings))).sort(), [
    'settings.json',
    'skills',
  ]);
});

test('explicit replacement of a hard-linked skill preserves the other fixture file', async (t) => {
  const { directory } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  const original = path.join(directory, 'owner-skill.md');
  await mkdir(dest);
  await writeFile(original, 'owner instructions');
  const target = path.join(dest, 'SKILL.md');
  await link(original, target);
  await assert.rejects(exportSkill(dest), { code: 'SKILL_EXISTS' });
  assert.equal((await exportSkill(dest, true)).status, 'replaced');
  assert.equal(await readFile(original, 'utf8'), 'owner instructions');
  assert.deepEqual(await readFile(target), bundled);
  assert.deepEqual(await readdir(dest), ['SKILL.md']);
});

test('different existing skill needs explicit overwrite and preserves neighboring user files', async (t) => {
  const { directory, run } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  await mkdir(dest);
  const file = path.join(dest, 'SKILL.md');
  await writeFile(file, 'owner instructions');
  await writeFile(path.join(dest, 'AGENTS.md'), 'owner agent policy');
  await writeFile(path.join(dest, 'CLAUDE.md'), 'owner Claude policy');
  const before = (await stat(file)).mtimeMs;
  for (const flags of [[], ['--yes']]) {
    const result = run('skill', 'export', '--output', dest, '--json', ...flags);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(file, 'utf8'), 'owner instructions');
    assert.equal((await stat(file)).mtimeMs, before);
  }
  const permitted = run(
    'skill',
    'export',
    '--output',
    dest,
    '--overwrite',
    '--json',
  );
  assert.equal(permitted.status, 0, permitted.stderr);
  assert.equal(JSON.parse(permitted.stdout).status, 'replaced');
  assert.deepEqual(await readFile(file), bundled);
  assert.equal(
    await readFile(path.join(dest, 'AGENTS.md'), 'utf8'),
    'owner agent policy',
  );
  assert.equal(
    await readFile(path.join(dest, 'CLAUDE.md'), 'utf8'),
    'owner Claude policy',
  );
  assert.deepEqual((await readdir(dest)).sort(), [
    'AGENTS.md',
    'CLAUDE.md',
    'SKILL.md',
  ]);
});

test('an oversized existing file is preserved unless explicitly replaced', async (t) => {
  const { directory } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  await mkdir(dest);
  const bytes = Buffer.alloc(300_000, 65);
  await writeFile(path.join(dest, 'SKILL.md'), bytes);
  await assert.rejects(exportSkill(dest), { code: 'SKILL_EXISTS' });
  assert.deepEqual(await readFile(path.join(dest, 'SKILL.md')), bytes);
  assert.equal((await exportSkill(dest, true)).status, 'replaced');
});

test('invalid directories and directory-shaped SKILL.md are rejected', async (t) => {
  const { directory } = await fixture(t);
  const file = path.join(directory, 'ordinary-file');
  await writeFile(file, 'preserve');
  await assert.rejects(exportSkill(path.join(file, 'nested')), {
    code: 'UNSAFE_SKILL_PATH',
  });
  assert.equal(await readFile(file, 'utf8'), 'preserve');
  const dest = path.join(directory, 'membrain');
  await mkdir(path.join(dest, 'SKILL.md'), { recursive: true });
  await assert.rejects(exportSkill(dest, true), { code: 'UNSAFE_SKILL_PATH' });
  assert.deepEqual(await readdir(path.join(dest, 'SKILL.md')), []);
});

test('directory links/junctions never redirect export into another fixture project', async (t) => {
  const { directory } = await fixture(t);
  const other = path.join(directory, 'other-project');
  await mkdir(other);
  await writeFile(path.join(other, 'AGENTS.md'), 'unchanged');
  const alias = path.join(directory, 'alias');
  await symlink(
    other,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(exportSkill(path.join(alias, 'membrain'), true), {
    code: 'UNSAFE_SKILL_PATH',
  });
  assert.deepEqual(await readdir(other), ['AGENTS.md']);
});

test('a linked SKILL.md is refused even with overwrite permission', async (t) => {
  const { directory } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  const target = path.join(directory, 'owner-policy.md');
  await mkdir(dest);
  await writeFile(target, 'unchanged');
  try {
    await symlink(target, path.join(dest, 'SKILL.md'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('File symlinks need Windows developer mode/privilege');
      return;
    }
    throw error;
  }
  await assert.rejects(exportSkill(dest, true), { code: 'UNSAFE_SKILL_PATH' });
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test(
  'permission failure is actionable and leaves the original skill intact',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const { directory } = await fixture(t);
    const dest = path.join(directory, 'membrain');
    await mkdir(dest);
    const file = path.join(dest, 'SKILL.md');
    await writeFile(file, 'original');
    await chmod(dest, 0o500);
    try {
      await assert.rejects(exportSkill(dest, true), {
        code: 'SKILL_EXPORT_FAILED',
      });
      assert.equal(await readFile(file, 'utf8'), 'original');
    } finally {
      await chmod(dest, 0o700);
    }
  },
);

test('concurrent subprocess exports produce one complete file and no extra artifacts', async (t) => {
  const { directory, options } = await fixture(t);
  const dest = path.join(directory, 'membrain');
  const results = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [cli, 'skill', 'export', '--output', dest, '--json'],
            options,
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (part) => {
            stdout += part;
          });
          child.stderr.on('data', (part) => {
            stderr += part;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, stderr }));
        }),
    ),
  );
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      ['created', 'unchanged'].includes(JSON.parse(result.stdout).status),
    );
  }
  assert.equal(
    results.filter((result) => JSON.parse(result.stdout).status === 'created')
      .length,
    1,
  );
  assert.deepEqual(await readFile(path.join(dest, 'SKILL.md')), bundled);
  assert.deepEqual(await readdir(dest), ['SKILL.md']);
});

test('export leaves mock agent configurations and other fixture projects untouched', async (t) => {
  const { directory, run } = await fixture(t);
  const files = [
    '.claude/settings.json',
    '.codex/config.toml',
    '.agents/skills/custom/SKILL.md',
    'other-project/AGENTS.md',
    'other-project/CLAUDE.md',
  ];
  for (const name of files) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `preserve ${name}`);
  }
  const result = run(
    '--config',
    path.join(directory, 'not-configured.json'),
    'skill',
    'export',
    '--output',
    './review/membrain',
    '--json',
  );
  assert.equal(result.status, 0, result.stderr);
  for (const name of files)
    assert.equal(
      await readFile(path.join(directory, name), 'utf8'),
      `preserve ${name}`,
    );
  assert.deepEqual((await readdir(directory)).sort(), [
    '.agents',
    '.claude',
    '.codex',
    'other-project',
    'review',
  ]);
  assert.deepEqual(await readdir(path.join(directory, '.claude')), [
    'settings.json',
  ]);
  assert.deepEqual(await readdir(path.join(directory, '.codex')), [
    'config.toml',
  ]);
});

test('relocated package resolves its bundled skill independently of the repository working directory', async (t) => {
  const { directory } = await fixture(t);
  const pkg = path.join(directory, 'package');
  await mkdir(pkg);
  await cp(path.join(root, 'dist'), path.join(pkg, 'dist'), {
    recursive: true,
  });
  await cp(path.join(root, 'skills'), path.join(pkg, 'skills'), {
    recursive: true,
  });
  await cp(path.join(root, 'package.json'), path.join(pkg, 'package.json'));
  const relocated = await import(
    pathToFileURL(path.join(pkg, 'dist', 'skill.js')).href
  );
  const result = await relocated.exportSkill(
    path.join(directory, 'export', 'membrain'),
  );
  assert.deepEqual(await readFile(result.path), bundled);
  await unlink(path.join(pkg, 'skills', 'membrain', 'SKILL.md'));
  const newDestination = path.join(directory, 'must-not-be-created');
  await assert.rejects(relocated.exportSkill(newDestination), {
    code: 'SKILL_EXPORT_FAILED',
  });
  await assert.rejects(stat(newDestination), { code: 'ENOENT' });
  await writeFile(result.path, 'owner customization');
  await assert.rejects(relocated.exportSkill(path.dirname(result.path), true), {
    code: 'SKILL_EXPORT_FAILED',
  });
  assert.equal(await readFile(result.path, 'utf8'), 'owner customization');
  assert.deepEqual(await readdir(path.dirname(result.path)), ['SKILL.md']);
});

test('skill CLI examples support recall, scoped saves, revision-safe updates and superseding offline', async (t) => {
  const { directory, run } = await fixture(t);
  const config = path.join(directory, 'fixture-config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      global: { path: './global' },
      projects: [
        { projectId: 'example', root: directory, path: './project-memory' },
      ],
      session: { path: './sessions' },
    }),
  );
  function command(...args) {
    const result = run('--config', config, '--json', ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.equal(
    command('remember', '--scope', 'project', '--', '--clear-tags').record
      .content,
    '--clear-tags',
  );
  assert.equal(
    command('search', 'database SQLite', '--scope', 'project', '--limit', '5')
      .results.length,
    0,
  );
  const saved = command(
    'remember',
    'Use SQLite for local indexing; JSONL remains authoritative.',
    '--scope',
    'project',
    '--type',
    'decision',
    '--tag',
    'storage',
  ).record;
  command(
    'remember',
    'Prefer strict TypeScript.',
    '--scope',
    'global',
    '--type',
    'preference',
  );
  command(
    'remember',
    'Check SQLite benchmarks tomorrow.',
    '--scope',
    'session',
    '--session',
    'explicit-test-session',
  );
  const recalled = command(
    'recall',
    'SQLite indexing',
    '--limit',
    '5',
    '--max-chars',
    '4000',
  );
  assert.equal(recalled.results.length, 1);
  assert.equal(recalled.results[0].id, saved.id);
  assert.equal(recalled.untrusted, true);
  const updated = command(
    'update',
    saved.id,
    'Use SQLite FTS5 for indexing; JSONL stays authoritative.',
    '--scope',
    'project',
    '--expected-revision',
    saved.revisionId,
  ).record;
  assert.equal(updated.id, saved.id);
  const stale = run(
    '--config',
    config,
    'update',
    saved.id,
    'stale input',
    '--scope',
    'project',
    '--expected-revision',
    saved.revisionId,
    '--json',
  );
  assert.notEqual(stale.status, 0);
  const historical = command(
    'update',
    saved.id,
    '--scope',
    'project',
    '--status',
    'superseded',
    '--expected-revision',
    updated.revisionId,
  ).record;
  assert.equal(command('recall', 'SQLite').results.length, 0);
  assert.equal(
    command('recall', 'SQLite', '--session', 'explicit-test-session').results
      .length,
    1,
  );
  command(
    'forget',
    saved.id,
    '--scope',
    'project',
    '--expected-revision',
    historical.revisionId,
    '--yes',
  );
  assert.equal(
    command('list', '--scope', 'project', '--status', 'deleted').results.length,
    1,
  );
});
