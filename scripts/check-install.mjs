import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// Every npm write, configuration file, install prefix, and memory is disposable.
// This never installs over the user's global Membrain command.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run install:check.');
const root = fileURLToPath(new URL('../', import.meta.url));
// macOS can expose its temporary directory through /var -> /private/var.
// Export intentionally rejects linked ancestors; give it the real fixture path.
const temporaryRoot = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, 'membrain-install-'));
assert.equal(path.dirname(directory), temporaryRoot);
try {
  const prefix = path.join(directory, 'isolated prefix');
  const cwd = path.join(directory, 'outside source repository');
  const userconfig = path.join(directory, 'npmrc');
  const globalconfig = path.join(directory, 'global-npmrc');
  await mkdir(cwd);
  await writeFile(userconfig, '');
  await writeFile(globalconfig, '');
  const env = {
    ...process.env,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: path.join(directory, 'npm cache'),
    npm_config_update_notifier: 'false',
    MEMBRAIN_CONFIG: path.join(directory, 'memory config.json'),
    MEMBRAIN_CACHE_DIR: path.join(directory, 'memory cache'),
  };
  function run(
    executable,
    args,
    workingDirectory = cwd,
    input,
    childEnv = env,
  ) {
    const result = spawnSync(executable, args, {
      cwd: workingDirectory,
      env: childEnv,
      encoding: 'utf8',
      input,
      timeout: 240_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  }
  const packed = JSON.parse(
    run(
      process.execPath,
      [
        npm,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        directory,
      ],
      root,
    ),
  )[0];
  for (const file of packed.files)
    assert.match(
      file.path,
      /^(dist\/.*\.js|docs\/.*\.md|skills\/membrain\/SKILL\.md|package\.json|LICENSE|README\.md)$/u,
      `Unexpected archive file: ${file.path}`,
    );
  const archive = path.join(directory, packed.filename);
  run(process.execPath, [
    npm,
    'install',
    '--global',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    archive,
  ]);
  const moduleRoot = path.join(
    prefix,
    ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules',
    'membrain',
  );
  const entry = path.join(moduleRoot, 'dist', 'cli.js');
  const version = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ).version;
  // Exercise the actual global shim/executable outside the checkout.
  let shimVersion;
  if (process.platform === 'win32') {
    const shim = path.join(prefix, 'membrain.cmd').replaceAll("'", "''");
    shimVersion = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& '${shim}' --version; exit $LASTEXITCODE`,
    ]);
  } else {
    shimVersion = run(path.join(prefix, 'bin', 'membrain'), ['--version']);
  }
  assert.equal(shimVersion, version);
  const cliEnv = {
    ...env,
    PATH: '',
    NODE_OPTIONS: '',
    CODEX_HOME: path.join(directory, 'mock codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'mock claude'),
    APPDATA: directory,
    XDG_CONFIG_HOME: directory,
  };
  delete cliEnv.T3_ACP_MCP_NODE;
  const cli = (args, input) =>
    JSON.parse(
      run(process.execPath, [entry, '--json', ...args], cwd, input, cliEnv),
    );
  const initialized = cli([
    'init',
    '--non-interactive',
    '--global-path',
    path.join(directory, 'global memories'),
    '--yes',
  ]);
  assert.equal(initialized.status, 'initialized');
  const saved = cli(
    ['remember', '--scope', 'global', '--type', 'decision', '--stdin'],
    'Use SQLite for portable installed-package retrieval.',
  );
  const recalled = cli(['recall', 'SQLite', '--scope', 'global']);
  assert.equal(recalled.results[0].id, saved.record.id);
  assert.equal(
    cli(['recall', 'SQLite', '--scope', 'global', '--read-only']).index.rebuilt,
    false,
  );
  assert.equal(
    cli(['search', 'SQLite', '--scope', 'global', '--rebuild-index']).index
      .rebuilt,
    true,
  );
  const destination = path.join(directory, 'manual skill export');
  assert.equal(
    cli(['skill', 'export', '--output', destination]).status,
    'created',
  );
  assert.equal(
    cli(['skill', 'export', '--output', destination]).status,
    'unchanged',
  );
  assert.equal(
    await readFile(path.join(destination, 'SKILL.md'), 'utf8'),
    await readFile(path.join(root, 'skills', 'membrain', 'SKILL.md'), 'utf8'),
  );
  assert.deepEqual(await readdir(destination), ['SKILL.md']);
  // npm omits dev dependencies from a packed global install.
  const dependencyRoots = [
    path.join(
      prefix,
      ...(process.platform === 'win32' ? [] : ['lib']),
      'node_modules',
    ),
    path.join(moduleRoot, 'node_modules'),
  ];
  for (const dependencyRoot of dependencyRoots) {
    const names = await readdir(dependencyRoot).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of ['typescript', 'eslint', 'prettier'])
      assert.equal(
        names.includes(name),
        false,
        `${name} leaked into production installation`,
      );
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        packageVersion: version,
        archiveFiles: packed.files.length,
        isolatedGlobalShim: 'passed',
        init: 'passed',
        rememberRecall: 'passed',
        rebuild: 'passed',
        readOnly: 'passed',
        skillExport: 'passed',
        devDependencies: 'absent',
        published: false,
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
