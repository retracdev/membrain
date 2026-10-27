import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from '@inquirer/testing';
import { initContext, buildInitPlan } from '../dist/init/plan.js';
import { applyInitPlan } from '../dist/init/persist.js';
import { detectAgents, detectProject } from '../dist/init/detect.js';
import { inputPath, validateDirectory } from '../dist/init/paths.js';
import { runWizard, terminalPrompts } from '../dist/init/wizard.js';
import { MemoryEngine } from '../dist/engine/engine.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'membrain-init-')),
  );
  assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('membrain-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'code base');
  const nested = path.join(root, 'nested', 'deep');
  await mkdir(nested, { recursive: true });
  const configPath = path.join(directory, 'settings', 'config.json');
  const env = {
    ...process.env,
    PATH: '',
    APPDATA: directory,
    XDG_CONFIG_HOME: directory,
  };
  delete env.MEMBRAIN_CONFIG;
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [cli, '--config', configPath, '--json', ...args],
      { cwd: nested, env, encoding: 'utf8' },
    );
  return {
    directory,
    root,
    nested,
    configPath,
    run,
    context: () => initContext(configPath, nested),
  };
}
function data(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function error(result, code) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.equal(result.stdout, '');
}
const local = { mode: 'local' };

test('fresh non-interactive setup uses custom paths and all three isolated local scopes offline', async (t) => {
  const f = await fixture(t);
  const paths = ['mémoire globale', 'project archive', 'session archive'].map(
    (item) => path.join(f.directory, item),
  );
  await mkdir(paths[0]);
  await writeFile(path.join(paths[0], 'owner.txt'), 'keep unrelated data');
  const result = data(
    f.run(
      'init',
      '--non-interactive',
      '--global-path',
      paths[0],
      '--project-root',
      f.root,
      '--project-path',
      paths[1],
      '--session-path',
      paths[2],
    ),
  );
  assert.equal(result.status, 'initialized');
  assert.equal(result.config.version, 1);
  for (const scope of ['global', 'session'])
    assert.deepEqual(result.config[scope].sync, local);
  assert.deepEqual(result.config.projects[0].sync, local);
  assert.deepEqual(
    [
      result.config.global.path,
      result.config.projects[0].path,
      result.config.session.path,
    ],
    paths,
  );
  assert.equal(
    await readFile(path.join(paths[0], 'owner.txt'), 'utf8'),
    'keep unrelated data',
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.root, '.membrain', 'project.json'), 'utf8'),
    ).projectId,
    result.config.projects[0].projectId,
  );
  const engine = new MemoryEngine(
    result.config,
    f.nested,
    path.join(f.directory, 'cache'),
  );
  const global = await engine.remember(
    { scope: 'global' },
    { content: 'Global setup preference' },
  );
  const project = await engine.remember(
    { scope: 'project' },
    { content: 'Project architecture decision' },
  );
  const session = await engine.remember(
    { scope: 'session', session: 'task-1' },
    { content: 'Session temporary findings' },
  );
  const records = await engine.query({}, { limit: 10 });
  assert.deepEqual(
    new Set(records.results.map((item) => item.record.id)),
    new Set([global.record.id, project.record.id]),
  );
  assert.equal(
    (await engine.query({ scope: 'session', session: 'task-1' }, { limit: 10 }))
      .results[0].record.id,
    session.record.id,
  );
  assert.equal(
    (await engine.query({ scope: 'session', session: 'task-2' }, { limit: 10 }))
      .results.length,
    0,
  );
  const outside = new MemoryEngine(
    result.config,
    f.directory,
    path.join(f.directory, 'cache'),
  );
  assert.equal((await outside.query({}, { limit: 10 })).results.length, 1);
  const bytes = await readFile(f.configPath, 'utf8');
  const repeat = data(
    f.run('init', '--non-interactive', '--global', '--project', '--session'),
  );
  assert.equal(repeat.status, 'unchanged');
  assert.equal(repeat.backupPath, undefined);
  assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  assert.deepEqual(
    (
      await engine.query({ scope: 'session', session: 'task-1' }, { limit: 10 })
    ).results.map((item) => item.record.id),
    [session.record.id],
  );
  assert.deepEqual(
    new Set(
      (await engine.query({}, { limit: 10 })).results.map(
        (item) => item.record.id,
      ),
    ),
    new Set([global.record.id, project.record.id]),
  );
});

test('updates require explicit overwrite, preserve skipped scopes, and back up exact legacy bytes', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.configPath));
  const original =
    '{"version":1,"global":{"path":"../old global"},"session":{"path":"../sessions"}}\n';
  await writeFile(f.configPath, original);
  const location = path.join(f.directory, 'new global');
  error(
    f.run('init', '--non-interactive', '--global-path', location, '--yes'),
    'OVERWRITE_CONFIRMATION_REQUIRED',
  );
  assert.equal(await readFile(f.configPath, 'utf8'), original);
  assert.equal((await readdir(f.directory)).includes('new global'), false);
  const result = data(
    f.run(
      'init',
      '--non-interactive',
      '--global-path',
      location,
      '--overwrite-config',
    ),
  );
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
  assert.equal(result.config.session.path, path.join(f.directory, 'sessions'));
  assert.equal(
    (await readdir(path.dirname(f.configPath))).filter((item) =>
      item.endsWith('.membrain-backup'),
    ).length,
    1,
  );
});

test('fresh flags must select scopes and non-TTY never prompts; dry run creates nothing', async (t) => {
  const f = await fixture(t);
  const initial = await readdir(f.directory);
  error(f.run('init'), 'INIT_REQUIRES_TTY');
  error(f.run('init', '--non-interactive', '--yes'), 'SCOPE_REQUIRED');
  error(
    f.run('init', '--non-interactive', '--project'),
    'PROJECT_ROOT_REQUIRED',
  );
  const preview = data(
    f.run(
      'init',
      '--non-interactive',
      '--global',
      '--session',
      '--project-root',
      f.root,
      '--dry-run',
    ),
  );
  assert.equal(preview.status, 'dry-run');
  assert.equal(preview.config.global.sync.mode, 'local');
  assert.deepEqual(await readdir(f.directory), initial);
  assert.deepEqual(await readdir(f.root), ['nested']);
});

test('sync preferences are independent, explicit auto permission is required per location and target', async (t) => {
  const f = await fixture(t);
  error(
    f.run('init', '--non-interactive', '--global-sync', 'automatic', '--yes'),
    'AUTO_SYNC_AUTHORIZATION_REQUIRED',
  );
  const result = data(
    f.run(
      'init',
      '--non-interactive',
      '--global-sync',
      'automatic',
      '--authorize-global-auto-sync',
      '--session-sync',
      'manual',
      '--session-remote',
      'origin',
      '--session-branch',
      'memory/main',
      '--project-root',
      f.root,
    ),
  );
  assert.deepEqual(result.config.global.sync, {
    mode: 'automatic',
    authorized: true,
  });
  assert.deepEqual(result.config.projects[0].sync, local);
  assert.deepEqual(result.config.session.sync, {
    mode: 'manual',
    remote: 'origin',
    branch: 'memory/main',
  });
  assert.equal(
    data(f.run('init', '--non-interactive', '--global')).status,
    'unchanged',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--global-path',
      path.join(f.directory, 'another'),
      '--overwrite-config',
    ),
    'AUTO_SYNC_AUTHORIZATION_REQUIRED',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--global-remote',
      'origin',
      '--global-branch',
      'new-target',
      '--overwrite-config',
    ),
    'AUTO_SYNC_AUTHORIZATION_REQUIRED',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--session-sync',
      'local',
      '--session-remote',
      'origin',
    ),
    'INVALID_SYNC_POLICY',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--session-remote',
      'https://credentials@example.com/repo',
    ),
    'INVALID_SYNC_POLICY',
  );
  error(
    f.run('init', '--non-interactive', '--session-branch', '../bad'),
    'INVALID_SYNC_POLICY',
  );
});

test('nested repositories, submodule/worktree .git files, marker clones and non-Git roots resolve safely', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.git'));
  await writeFile(path.join(f.root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const initial = data(f.run('init', '--non-interactive', '--project'));
  assert.equal(initial.config.projects[0].root, f.root);
  assert.equal(
    await readFile(path.join(f.root, '.git', 'HEAD'), 'utf8'),
    'ref: refs/heads/main\n',
  );
  assert.deepEqual(await readdir(path.join(f.root, '.git')), ['HEAD']);
  const other = path.join(f.root, 'submodule');
  await mkdir(path.join(other, 'nested'), { recursive: true });
  await writeFile(
    path.join(other, '.git'),
    'gitdir: ../../.git/modules/submodule\n',
  );
  const nestedContext = await initContext(
    f.configPath,
    path.join(other, 'nested'),
  );
  assert.equal(nestedContext.project.root, other);
  assert.equal(nestedContext.project.projectId, undefined);
  const subplan = await buildInitPlan(nestedContext, { project: true });
  assert.notEqual(subplan.project.projectId, initial.project.projectId);
  const clone = path.join(f.directory, 'clone');
  await mkdir(path.join(clone, '.membrain'), { recursive: true });
  await writeFile(
    path.join(clone, '.membrain', 'project.json'),
    await readFile(path.join(f.root, '.membrain', 'project.json')),
  );
  const cloneContext = await initContext(f.configPath, clone);
  const clonePlan = await buildInitPlan(cloneContext, { project: true });
  assert.equal(clonePlan.project.projectId, initial.project.projectId);
  assert.equal(
    clonePlan.config.projects[1].path,
    initial.config.projects[0].path,
  );
  const noMarker = path.join(f.directory, 'non-git');
  await mkdir(noMarker);
  const localPlan = await buildInitPlan(
    await initContext(f.configPath, noMarker),
    { projectRoot: noMarker, projectMarker: false },
  );
  assert.equal(localPlan.marker, undefined);
  assert.equal(
    (await detectProject(localPlan.config, noMarker)).kind,
    'configured',
  );
});

test('invalid paths, overlapping roots, protected files, malformed config and markers are preserved', async (t) => {
  const f = await fixture(t);
  const blocked = path.join(f.directory, 'blocked');
  await writeFile(blocked, 'owner bytes');
  await assert.rejects(validateDirectory(path.join(blocked, 'child')), {
    code: 'INVALID_PATH',
  });
  assert.equal(await readFile(blocked, 'utf8'), 'owner bytes');
  error(
    f.run(
      'init',
      '--non-interactive',
      '--global-path',
      path.join(blocked, 'child'),
    ),
    'INVALID_PATH',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--global-path',
      f.directory,
      '--session-path',
      path.join(f.directory, 'sessions'),
    ),
    'OVERLAPPING_STORES',
  );
  error(
    f.run(
      'init',
      '--non-interactive',
      '--project-root',
      path.join(f.directory, 'missing'),
    ),
    'INVALID_PATH',
  );
  assert.throws(() => inputPath('\u0000', f.directory), {
    code: 'INVALID_PATH',
  });
  if (process.platform === 'win32')
    for (const input of [
      'C:\\bad\\NUL',
      'C:\\bad\\trailing.',
      'C:\\bad\\wild*',
    ])
      assert.throws(() => inputPath(input, f.directory), {
        code: 'INVALID_PATH',
      });
  await assert.rejects(
    initContext(path.join(f.directory, 'README.md'), f.root),
    { code: 'PROTECTED_FILE' },
  );
  await assert.rejects(initContext(path.join(f.directory, 'LICENSE'), f.root), {
    code: 'PROTECTED_FILE',
  });
  await mkdir(path.dirname(f.configPath));
  for (const bytes of [
    '{bad',
    '{"version":999}',
    '{"version":1,"unknown":true}',
  ]) {
    await writeFile(f.configPath, bytes);
    assert.equal(
      f.run('init', '--non-interactive', '--global', '--overwrite-config')
        .status,
      1,
    );
    assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  }
  await rm(f.configPath);
  await mkdir(path.join(f.root, '.membrain'));
  const marker = path.join(f.root, '.membrain', 'project.json');
  await writeFile(marker, 'owner-marker');
  error(
    f.run('init', '--non-interactive', '--global'),
    'INVALID_PROJECT_MARKER',
  );
  assert.equal(await readFile(marker, 'utf8'), 'owner-marker');
  assert.equal(await readFile(blocked, 'utf8'), 'owner bytes');
});

test('directory aliases work and overlapping aliases/config symlinks are refused', async (t) => {
  const f = await fixture(t);
  const real = path.join(f.directory, 'real');
  const alias = path.join(f.directory, 'alias');
  await mkdir(real);
  try {
    await symlink(
      real,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Symlinks unavailable');
      return;
    }
    throw error;
  }
  const plan = await buildInitPlan(await f.context(), { globalPath: alias });
  assert.equal(plan.config.global.path, real);
  await assert.rejects(
    buildInitPlan(await f.context(), {
      globalPath: real,
      sessionPath: path.join(alias, 'sessions'),
    }),
    { code: 'OVERLAPPING_STORES' },
  );
  const original = path.join(f.directory, 'source.json');
  await writeFile(original, '{"version":1}');
  await mkdir(path.dirname(f.configPath));
  try {
    await symlink(original, f.configPath, 'file');
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(f.context(), { code: 'INVALID_CONFIG_TARGET' });
  assert.equal(await readFile(original, 'utf8'), '{"version":1}');
});

test('POSIX unwritable directories fail without modifying configuration', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip(
      'POSIX permissions require a non-root POSIX runner; Windows ACLs are not chmod permissions',
    );
    return;
  }
  const f = await fixture(t);
  const denied = path.join(f.directory, 'read-only');
  await mkdir(denied);
  await chmod(denied, 0o500);
  t.after(() => chmod(denied, 0o700).catch(() => undefined));
  await assert.rejects(validateDirectory(denied), {
    code: 'PATH_NOT_WRITABLE',
  });
  await assert.rejects(
    buildInitPlan(await f.context(), { globalPath: denied }),
    { code: 'PATH_NOT_WRITABLE' },
  );
});

test('competing setup plans never overwrite a changed configuration or project marker', async (t) => {
  const f = await fixture(t);
  const context = await f.context();
  const a = await buildInitPlan(context, { global: true });
  const b = await buildInitPlan(context, { session: true });
  await applyInitPlan(a);
  const bytes = await readFile(f.configPath, 'utf8');
  await assert.rejects(applyInitPlan(b), { code: 'CONFIG_CHANGED' });
  assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  const plan = await buildInitPlan(await f.context(), { projectRoot: f.root });
  await mkdir(path.dirname(plan.marker.path), { recursive: true });
  await writeFile(plan.marker.path, 'unrelated marker appeared');
  await assert.rejects(applyInitPlan(plan, true), {
    code: 'PROJECT_MARKER_CHANGED',
  });
  assert.equal(await readFile(f.configPath, 'utf8'), bytes);
  assert.equal(
    await readFile(plan.marker.path, 'utf8'),
    'unrelated marker appeared',
  );
});

test('existing store identity is reused, never reassigned; orphan records are refused', async (t) => {
  const f = await fixture(t);
  const result = data(
    f.run(
      'init',
      '--non-interactive',
      '--project-root',
      f.root,
      '--no-project-marker',
    ),
  );
  const engine = new MemoryEngine(
    result.config,
    f.root,
    path.join(f.directory, 'cache'),
  );
  await engine.remember({}, { content: 'Preserve this project memory' });
  const plan = await buildInitPlan(await f.context(), {
    project: true,
    projectId: result.project.projectId,
  });
  assert.equal(plan.project.projectId, result.project.projectId);
  await assert.rejects(
    buildInitPlan(await f.context(), {
      project: true,
      projectId: 'another-project',
    }),
    { code: 'PROJECT_ID_MISMATCH' },
  );
  await assert.rejects(
    buildInitPlan(await f.context(), {
      globalPath: result.config.projects[0].path,
    }),
    { code: 'STORE_IDENTITY_MISMATCH' },
  );
  const orphan = path.join(f.directory, 'orphan');
  await mkdir(path.join(orphan, 'records'), { recursive: true });
  await assert.rejects(
    buildInitPlan(await f.context(), { globalPath: orphan }),
    { code: 'STORE_IDENTITY_MISMATCH' },
  );
});

test('agent detection reads only hints, with Windows and POSIX PATH conventions', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, '.codex'));
  const bin = path.join(f.directory, 'bin');
  await mkdir(bin);
  const executable = path.join(
    bin,
    process.platform === 'win32' ? 'claude.cmd' : 'claude',
  );
  await writeFile(executable, 'THIS MUST NEVER EXECUTE');
  await chmod(executable, 0o700);
  const agents = await detectAgents({
    env: { PATH: bin, T3_ACP_MCP_NODE: 'runtime hint' },
    home: f.directory,
  });
  assert.equal(
    agents.find((agent) => agent.name === 'Claude Code').detected,
    true,
  );
  assert.equal(agents.find((agent) => agent.name === 'Codex').detected, true);
  assert.equal(agents.find((agent) => agent.name === 'T3 Code').detected, true);
  assert.ok(agents.every((agent) => agent.integration === 'unavailable'));
  const absent = await detectAgents({
    env: { PATH: '' },
    home: path.join(f.directory, 'missing'),
  });
  assert.ok(absent.every((agent) => !agent.detected));
});

function scriptedUI({
  scopes = ['global'],
  inputs = {},
  selections = {},
  confirm = () => true,
} = {}) {
  const notes = [];
  return {
    notes,
    note: (message) => notes.push(message),
    scopes: async () => scopes,
    input: async (message, fallback) => inputs[message] ?? fallback,
    select: async (message, choices, fallback) =>
      selections[message] ?? fallback,
    confirm: async (message, fallback) => confirm(message, fallback),
  };
}
test('wizard cancellation and declined overwrite leave configuration and memories intact', async (t) => {
  const f = await fixture(t);
  const context = await f.context();
  const cancelled = await runWizard(
    context,
    {},
    scriptedUI({ confirm: () => false }),
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await readdir(f.directory)).includes('settings'), false);
  await runWizard(context, {}, scriptedUI());
  const original = await readFile(f.configPath, 'utf8');
  const ui = scriptedUI({
    inputs: {
      'global: memory storage directory': path.join(f.directory, 'changed'),
    },
    confirm: (message) => !message.startsWith('Replace the existing'),
  });
  const refused = await runWizard(await f.context(), { yes: true }, ui);
  assert.equal(refused.status, 'cancelled');
  assert.equal(await readFile(f.configPath, 'utf8'), original);
  assert.ok(
    ui.notes.some((message) =>
      message.includes('Integrations are not available'),
    ),
  );
});

test('wizard repeats authorization after validation retry and keeps automatic policy on unchanged rerun', async (t) => {
  const f = await fixture(t);
  let round = 0;
  let consents = 0;
  const ui = {
    note: () => {},
    scopes: async () => {
      round++;
      return ['global', 'session'];
    },
    input: async (message, fallback) =>
      message === 'global: memory storage directory'
        ? path.join(f.directory, round === 1 ? 'sessions' : 'global')
        : message === 'session: memory storage directory'
          ? path.join(f.directory, 'sessions')
          : fallback,
    select: async (message, _choices, fallback) =>
      message.startsWith('global:') ? 'automatic' : fallback,
    confirm: async (message) => {
      if (message.startsWith('Authorize')) consents++;
      return true;
    },
  };
  const result = await runWizard(await f.context(), {}, ui);
  assert.equal(result.status, 'initialized');
  assert.equal(round, 2);
  assert.equal(consents, 2);
  const unchanged = await runWizard(await f.context(), {}, scriptedUI());
  assert.equal(unchanged.status, 'unchanged');
});

test(
  'real terminal prompt adapter drives all three scopes through interactive setup',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const context = await f.context();
    const controller = new globalThis.AbortController();
    t.after(() => controller.abort());
    // Run the production wizard/adapter against Inquirer's instrumented terminal streams.
    const terminal = await render(async (_config, streams) => {
      // Like real stderr, keep the shared output open between prompt instances.
      streams.output.end = () => streams.output;
      return runWizard(
        context,
        {},
        await terminalPrompts({ ...streams, signal: controller.signal }),
      );
    }, {});
    assert.match(terminal.getScreen(), /Which memory scopes/u);
    terminal.events.keypress('down');
    terminal.events.keypress('down');
    terminal.events.keypress('space');
    terminal.events.keypress('enter');
    const questions = [
      'global: memory storage directory',
      'global: how should Membrain',
      'Project root',
      'project: memory storage directory',
      'project: how should Membrain',
      'session: memory storage directory',
      'session: how should Membrain',
      'portable .membrain/project.json marker',
      'Save this setup?',
    ];
    for (const question of questions) {
      for (
        let tries = 0;
        !terminal.getScreen().includes(question) && tries < 200;
        tries++
      ) {
        await delay(25);
      }
      assert.ok(
        terminal.getScreen().includes(question),
        `${question}: ${terminal.getScreen()}`,
      );
      terminal.events.keypress('enter');
    }
    const result = await terminal.answer;
    assert.equal(result.status, 'initialized');
    assert.ok(result.config.global && result.config.session);
    assert.equal(result.config.projects.length, 1);
    assert.ok(
      [
        result.config.global,
        result.config.session,
        ...result.config.projects,
      ].every((scope) => scope.sync.mode === 'local'),
    );
  },
);

test('wizard declines automatic consent without saving an automatic policy', async (t) => {
  const f = await fixture(t);
  let modePrompts = 0;
  let asked = false;
  const ui = scriptedUI();
  ui.select = async () => (++modePrompts === 1 ? 'automatic' : 'local');
  ui.confirm = async (message) => {
    if (message.startsWith('Authorize')) {
      asked = true;
      return false;
    }
    return true;
  };
  const result = await runWizard(await f.context(), {}, ui);
  assert.equal(asked, true);
  assert.equal(modePrompts, 2);
  assert.deepEqual(result.config.global.sync, local);
});

test('interactive clone setup reuses marker-linked memory and changing project root chooses its own defaults', async (t) => {
  const f = await fixture(t);
  const initial = data(
    f.run('init', '--non-interactive', '--project-root', f.root),
  );
  const clone = path.join(f.directory, 'clone');
  await mkdir(path.join(clone, '.membrain'), { recursive: true });
  await writeFile(
    path.join(clone, '.membrain', 'project.json'),
    await readFile(path.join(f.root, '.membrain', 'project.json')),
  );
  const cloneResult = await runWizard(
    await initContext(f.configPath, clone),
    { overwriteConfig: true },
    scriptedUI({ scopes: ['project'] }),
  );
  assert.equal(
    cloneResult.config.projects[1].path,
    initial.config.projects[0].path,
  );
  assert.equal(
    cloneResult.config.projects[1].projectId,
    initial.project.projectId,
  );
  const other = path.join(f.directory, 'other');
  await mkdir(other);
  const ui = scriptedUI({ scopes: ['project'] });
  ui.input = async (message, fallback) =>
    message.startsWith('Project root') ? other : fallback;
  const result = await runWizard(
    await f.context(),
    { overwriteConfig: true },
    ui,
  );
  const added = result.config.projects.find((entry) => entry.root === other);
  assert.equal(added.path, path.join(other, '.membrain', 'project'));
  assert.notEqual(added.projectId, initial.project.projectId);
});
